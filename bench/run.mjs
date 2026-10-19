#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { readFile, mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { OpenAIBackend, isLoopback } from '../dist/backend.js';
import { runAgent } from '../dist/agent.js';
import { Permissions, sha256, errorInfo } from '../dist/core.js';
import { Store, newSession, writeJSON } from '../dist/storage.js';
import { Workspace } from '../dist/workspace.js';
import { runCommand, minimalEnv } from '../dist/command.js';
import { detectHardware } from '../dist/hardware.js';
const { values: v } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://127.0.0.1:1234/v1' },
    model: { type: 'string' },
    suite: { type: 'string', default: 'bench/eval-v1.jsonl' },
    out: { type: 'string', default: 'bench/results' },
    seed: { type: 'string', default: '42' },
    ctx: { type: 'string', default: '4096' },
    quantization: { type: 'string', default: 'unknown' },
    'allow-code-execution': { type: 'boolean' },
    limit: { type: 'string' },
  },
});
if (!v.model || !v['allow-code-execution'])
  throw new Error(
    'Require --model ID --allow-code-execution. Generated code executes in disposable projects with your OS permissions; use an isolated VM/container.',
  );
if (!isLoopback(v.url)) throw new Error('Benchmark runner is local-only; use a loopback backend');
const seed = Number(v.seed),
  ctx = Number(v.ctx);
if (!Number.isInteger(seed) || !Number.isInteger(ctx) || ctx < 2048)
  throw new Error('Invalid seed/ctx');
const raw = await readFile(v.suite, 'utf8');
const suite = raw.trim().split('\n').map(JSON.parse);
const ids = new Set();
for (const t of suite) {
  if (
    t.schema !== 1 ||
    t.split !== 'eval' ||
    t.license !== 'MIT' ||
    !Array.isArray(t.cases) ||
    ids.has(t.id)
  )
    throw new Error('Invalid/duplicate evaluation record');
  ids.add(t.id);
}
const limit = v.limit ? Number(v.limit) : suite.length;
if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid limit');
const hardware = await detectHardware(),
  records = [];
const runId = randomUUID();
await mkdir(v.out, { recursive: true });
const resultPath = path.join(v.out, runId + '.json');
const backend = new OpenAIBackend(v.url, v.model, 1024, seed);
const meta = {
  schema: 1,
  runId,
  startedAt: new Date().toISOString(),
  suiteSHA256: sha256(raw),
  seed,
  model: v.model,
  backend: v.url,
  context: ctx,
  contextConfirmedByBackend: false,
  quantization: v.quantization,
  hardware,
  userAcceptance: null,
  notes: [
    'Context/quantization are declared by caller; verify server configuration.',
    'Fixtures are held-out evaluation. Never copy into training data.',
    'No GPU or performance improvement is implied by runner tests.',
  ],
};
for (const scenario of suite.slice(0, limit))
  for (const mode of ['baseline', 'agent']) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'axiombench-'));
    const root = path.join(dir, 'project');
    await mkdir(root);
    await writeFile(path.join(root, 'solution.mjs'), scenario.initial);
    const start = performance.now();
    let record = {
      id: scenario.id,
      mode,
      success: false,
      testsPassed: 0,
      testsTotal: scenario.cases.length,
      toolFailures: null,
      toolCallSyntaxFailures: null,
      tokensPerSecond: null,
      completionTokens: null,
      cliRssBytes: null,
      modelMemoryBytes: null,
    };
    try {
      const store = new Store(path.join(dir, 'state')),
        session = newSession(root, backend.model, backend.baseURL);
      const permission = new Permissions(async (request) =>
        request.kind === 'write' && request.target === 'solution.mjs' ? 'once' : 'deny',
      );
      const workspace = new Workspace(root, permission, store, session.id);
      if (mode === 'baseline') {
        const prompt =
          scenario.prompt +
          '\nInitial solution.mjs:\n' +
          scenario.initial +
          '\nReturn only JSON {"content":"complete solution.mjs"}.';
        record.promptSHA256 = sha256(prompt);
        const reply = await backend.complete(
          [{ role: 'user', content: prompt }],
          [],
          AbortSignal.timeout(120000),
          () => {},
        );
        const data = JSON.parse(reply.message.content);
        if (typeof data.content !== 'string') throw new Error('Invalid baseline JSON');
        await workspace.write('solution.mjs', data.content);
        record.completionTokens = reply.usage.completion_tokens ?? null;
        record.tokensPerSecond =
          reply.usage.completion_tokens && reply.ttftMs !== null
            ? (reply.usage.completion_tokens - 1) /
              Math.max(0.001, (reply.elapsedMs - reply.ttftMs) / 1000)
            : null;
      } else {
        record.promptSHA256 = sha256(scenario.prompt);
        const result = await runAgent(backend, session, scenario.prompt, workspace, store, {
          signal: AbortSignal.timeout(180000),
          maxSteps: 12,
          contextChars: ctx * 3,
        });
        record.toolFailures = result.toolFailures;
        record.toolCallSyntaxFailures = result.syntaxFailures;
        record.completionTokens = result.completionTokens;
      }
      // Oracle is outside editable workspace. A completion marker prevents accidental process.exit(0) being a pass.
      const marker = randomUUID();
      const oracle = `import assert from 'node:assert/strict';\nimport {solve} from ${JSON.stringify(pathToFileURL(path.join(root, 'solution.mjs')).href)};\nconst cases=${JSON.stringify(scenario.cases)};\nfor(const [input,expected] of cases){const snapshot=structuredClone(input);assert.deepEqual(await solve(input),expected);assert.deepEqual(input,snapshot,'input mutated');}\nconsole.log(${JSON.stringify(marker)});\n`;
      // pathToFileURL handles Windows drive letters and spaces reliably.
      await writeFile(path.join(dir, 'oracle.mjs'), oracle);
      const checked = await runCommand(process.execPath, [path.join(dir, 'oracle.mjs')], root, {
        timeoutMs: 10000,
        env: minimalEnv(),
      });
      record.success =
        checked.exitCode === 0 && !checked.timedOut && checked.stdout.includes(marker);
      record.testsPassed = record.success ? scenario.cases.length : null;
      record.verification = {
        exitCode: checked.exitCode,
        timedOut: checked.timedOut,
        diagnostics: checked.stderr.slice(0, 2000),
      };
    } catch (e) {
      record.error = errorInfo(e);
    } finally {
      record.wallMs = performance.now() - start;
      record.cliRssBytes = process.memoryUsage().rss;
      records.push(record);
      await writeJSON(resultPath, {
        ...meta,
        records,
        summary: {
          completedRuns: records.length,
          successfulRuns: records.filter((r) => r.success).length,
        },
      });
      await rm(dir, { recursive: true, force: true });
    }
    console.log(JSON.stringify(record));
  }
console.log(`Results: ${resultPath}`);
