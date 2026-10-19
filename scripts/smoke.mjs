import { createServer } from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { sha256 } from '../dist/core.js';
import { npmCommand } from '../dist/command.js';
const base = await mkdtemp(path.join(os.tmpdir(), 'axiom-smoke-'));
const root = path.join(base, 'project');
await mkdir(root);
const before = 'export const sum = (a, b) => a - b;\n';
await writeFile(path.join(root, 'sum.mjs'), before);
await writeFile(
  path.join(root, 'package.json'),
  JSON.stringify({ type: 'module', scripts: { test: 'node --test test.mjs' } }),
);
await writeFile(
  path.join(root, 'test.mjs'),
  'import {sum} from "./sum.mjs"; import assert from "node:assert/strict"; assert.equal(sum(2,3),5);',
);
let completions = 0;
const server = createServer(async (req, res) => {
  if (req.url === '/v1/models') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'protocol-fixture' }] }));
    return;
  }
  let body = '';
  for await (const c of req) body += c;
  assert.equal(JSON.parse(body).model, 'protocol-fixture');
  res.setHeader('Content-Type', 'text/event-stream');
  const delta =
    completions++ === 0
      ? {
          tool_calls: [
            {
              index: 0,
              id: 'edit',
              function: {
                name: 'edit_file',
                arguments: JSON.stringify({
                  path: 'sum.mjs',
                  old_text: 'a - b',
                  new_text: 'a + b',
                  expected_sha256: sha256(before),
                }),
              },
            },
          ],
        }
      : { content: 'Updated arithmetic.' };
  const text = 'data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\ndata: [DONE]\n\n';
  for (let i = 0; i < text.length; i += 13) res.write(text.slice(i, i + 13));
  res.end();
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
try {
  const cmd = await npmCommand(['run', 'test']);
  const args = [
    'dist/cli.js',
    'run',
    'Fix sum',
    '--cwd',
    root,
    '--model',
    'protocol-fixture',
    '--url',
    `http://127.0.0.1:${server.address().port}/v1`,
    '--json',
    '--verify',
    '--allow-write',
    'sum.mjs',
    '--allow-command',
    JSON.stringify([cmd.program, ...cmd.args]),
  ];
  const child = spawn(process.execPath, args, {
    env: { ...process.env, PILOTCODE_HOME: path.join(base, 'data') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '',
    err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  const [code] = await once(child, 'close');
  assert.equal(code, 0, err + '\n' + out);
  assert.match(await readFile(path.join(root, 'sum.mjs'), 'utf8'), /a \+ b/);
  const events = out.trim().split('\n').map(JSON.parse);
  const result = events.find((e) => e.type === 'result');
  assert.equal(result.verification.status, 'passed');
  const files = await readdir(path.join(base, 'data/sessions'));
  assert.ok(files.some((f) => f.endsWith('.json')));
  const session = JSON.parse(
    await readFile(path.join(base, 'data/sessions', result.sessionId + '.json'), 'utf8'),
  );
  assert.equal(session.status, 'completed');
  console.log(
    'PASS: real CLI, HTTP/SSE protocol fixture, approved edit, actual Node test process, persisted session. This is NOT GPU/model inference validation.',
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(base, { recursive: true, force: true });
}
