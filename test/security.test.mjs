import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, link } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace, projectPath, readText } from '../dist/workspace.js';
import { Permissions, sha256 } from '../dist/core.js';
import { Store, newSession } from '../dist/storage.js';
import { Tools } from '../dist/tools.js';
import { runCommand } from '../dist/command.js';
import { compact } from '../dist/context.js';
import { diagnostics, verify } from '../dist/verify.js';
async function fixture(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'axiom-sec-'));
  const root = path.join(dir, 'project');
  await mkdir(root);
  const store = new Store(path.join(dir, 'data'));
  const session = newSession(root, 'test', 'http://127.0.0.1');
  try {
    await fn({
      dir,
      root,
      store,
      session,
      workspace: (approve) => new Workspace(root, new Permissions(approve), store, session.id),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
for (const file of [
  '../outside',
  'C:\\temp\\x',
  'file:stream',
  'foo/../../x',
  '.env.staging',
  'tls.pem',
  '.ssh/id_ed25519',
  '.npmrc',
  'token.json',
  'CON.txt',
  'name.',
])
  test(`rejects path ${file}`, () =>
    fixture(async ({ root }) => {
      await assert.rejects(projectPath(root, file, { writing: true }));
    }));
test('approval-time content replacement is detected without overwriting', () =>
  fixture(async ({ root, workspace }) => {
    await writeFile(path.join(root, 'a.txt'), 'before');
    const w = workspace(async () => {
      await writeFile(path.join(root, 'a.txt'), 'user edit');
      return 'once';
    });
    await assert.rejects(w.write('a.txt', 'agent edit'), { code: 'CONFLICT' });
    assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'user edit');
  }));
test('approval-time parent symlink substitution is denied', () =>
  fixture(async ({ dir, root, workspace }) => {
    await mkdir(path.join(root, 'src'));
    await mkdir(path.join(dir, 'outside'));
    const w = workspace(async () => {
      await rm(path.join(root, 'src'), { recursive: true });
      await symlink(
        path.join(dir, 'outside'),
        path.join(root, 'src'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      return 'once';
    });
    await assert.rejects(w.write('src/new.txt', 'bad'), { code: 'SYMLINK' });
    await assert.rejects(readFile(path.join(dir, 'outside/new.txt')), { code: 'ENOENT' });
  }));
test('read refuses hard links and invalid UTF8', () =>
  fixture(async ({ root }) => {
    await writeFile(path.join(root, 'a'), Buffer.from([0xff]));
    await assert.rejects(readText(path.join(root, 'a')), { code: 'FILE_ENCODING' });
    await link(path.join(root, 'a'), path.join(root, 'b'));
    await assert.rejects(readText(path.join(root, 'a')), { code: 'FILE_TYPE' });
  }));
test('undo restores prior bytes and refuses later user edits', () =>
  fixture(async ({ root, workspace }) => {
    await writeFile(path.join(root, 'a.txt'), 'user original\r\n');
    const w = workspace(async () => 'once');
    await w.write('a.txt', 'agent');
    await w.undo();
    assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'user original\r\n');
    await w.write('a.txt', 'agent2');
    await writeFile(path.join(root, 'a.txt'), 'user later');
    await assert.rejects(w.undo(), { code: 'CONFLICT' });
  }));
test('exact context edit preserves CRLF and rejects stale hash', () =>
  fixture(async ({ root, workspace }) => {
    const before = 'a\r\nb\r\n';
    await writeFile(path.join(root, 'a.txt'), before);
    const tools = new Tools(
      workspace(async () => 'once'),
      new AbortController().signal,
    );
    await tools.execute('edit_file', {
      path: 'a.txt',
      old_text: 'b\n',
      new_text: 'c\n',
      expected_sha256: sha256(before),
    });
    assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'a\r\nc\r\n');
    await assert.rejects(
      tools.execute('edit_file', {
        path: 'a.txt',
        old_text: 'c\n',
        new_text: 'd\n',
        expected_sha256: sha256(before),
      }),
      { code: 'CONFLICT' },
    );
  }));
test('permissions grant exact target only and reset revokes', async () => {
  let count = 0;
  const p = new Permissions(async () => {
    count++;
    return 'session';
  });
  const a = { kind: 'write', target: 'a', detail: 'x', cwd: '/project' };
  await p.require(a);
  await p.require(a);
  await p.require({ ...a, target: 'b' });
  assert.equal(count, 2);
  p.clear();
  await p.require(a);
  assert.equal(count, 3);
});
test('command captures separate streams and timeout is failure', () =>
  fixture(async ({ root }) => {
    const r = await runCommand(
      process.execPath,
      ['-e', 'console.log("out");console.error("err")'],
      root,
    );
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /out/);
    assert.match(r.stderr, /err/);
    const t = await runCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], root, {
      timeoutMs: 100,
    });
    assert.equal(t.timedOut, true);
    assert.notEqual(t.exitCode, 0);
  }));
test('command abort propagates and environment secrets are omitted', () =>
  fixture(async ({ root }) => {
    process.env.AXIOM_TEST_SECRET = 'do-not-inherit';
    const r = await runCommand(
      process.execPath,
      ['-e', 'console.log(process.env.AXIOM_TEST_SECRET ?? "absent")'],
      root,
    );
    assert.match(r.stdout, /absent/);
    delete process.env.AXIOM_TEST_SECRET;
    const abort = new AbortController();
    const promise = runCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], root, {
      signal: abort.signal,
    });
    setTimeout(() => abort.abort(), 100);
    assert.equal((await promise).cancelled, true);
  }));
test('session corruption preserves original and permits backup recovery', () =>
  fixture(async ({ store, session }) => {
    await store.save(session);
    session.messages.push({ role: 'user', content: 'first' });
    await store.save(session);
    await writeFile(store.sessionPath(session.id), '{broken');
    await assert.rejects(store.load(session.id), { code: 'SESSION_CORRUPT' });
    assert.equal(await readFile(store.sessionPath(session.id), 'utf8'), '{broken');
    await store.recover(session.id);
    assert.equal((await store.load(session.id)).id, session.id);
  }));
test('compaction keeps complete tool turns', () => {
  const m = [
    { role: 'user', content: 'old' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'a' }] },
    { role: 'tool', tool_call_id: 'a', content: 'x' },
    { role: 'assistant', content: 'done' },
    { role: 'user', content: 'new' },
  ];
  assert.deepEqual(compact(m, 60), [{ role: 'user', content: 'new' }]);
});
test('verify reports actual process failure and denied checks never pass', () =>
  fixture(async ({ workspace }) => {
    const check = {
      name: 'intentional failure',
      program: process.execPath,
      args: ['-e', 'console.error("a.ts(2,3): error TS2322: bad type");process.exit(1)'],
    };
    const fail = await verify(
      workspace(async () => 'once'),
      new AbortController().signal,
      [check],
    );
    assert.equal(fail.status, 'failed');
    assert.equal(fail.results[0].diagnostics[0].line, 2);
    const denied = await verify(
      workspace(async () => 'deny'),
      new AbortController().signal,
      [check],
    );
    assert.equal(denied.status, 'not-run');
    assert.equal(diagnostics('x.ts:3:4: error bad\nx.ts:3:4: error bad').length, 1);
  }));
test('approval-time replacement of the project root is rejected', () =>
  fixture(async ({ dir, root, workspace }) => {
    const outside = path.join(dir, 'replacement');
    await mkdir(outside);
    const moved = path.join(dir, 'original');
    const { rename } = await import('node:fs/promises');
    const w = workspace(async () => {
      await rename(root, moved);
      await symlink(outside, root, process.platform === 'win32' ? 'junction' : 'dir');
      return 'once';
    });
    await assert.rejects(w.write('new.txt', 'bad'), { code: 'ROOT_CHANGED' });
    await assert.rejects(readFile(path.join(outside, 'new.txt')), { code: 'ENOENT' });
  }));
test('abort during approval prevents a later approved write', () =>
  fixture(async ({ root, store, session }) => {
    const abort = new AbortController();
    const w = new Workspace(
      root,
      new Permissions(async () => {
        abort.abort();
        return 'once';
      }),
      store,
      session.id,
      () => {},
      abort.signal,
    );
    await assert.rejects(w.write('cancelled.txt', 'bad'));
    await assert.rejects(readFile(path.join(root, 'cancelled.txt')), { code: 'ENOENT' });
  }));

test('two independently loaded sessions cannot silently overwrite each other', () =>
  fixture(async ({ store, session }) => {
    await store.save(session);
    const other = new Store(store.root),
      snapshot = await other.load(session.id);
    session.messages.push({ role: 'user', content: 'first process' });
    await store.save(session);
    snapshot.messages.push({ role: 'user', content: 'stale second process' });
    await assert.rejects(other.save(snapshot), { code: 'SESSION_CONFLICT' });
    assert.equal((await store.load(session.id)).messages.at(-1).content, 'first process');
  }));

test('literal search uses allowed UTF8 content and excludes secrets', () =>
  fixture(async ({ root, workspace }) => {
    await writeFile(path.join(root, 'code.txt'), 'first\nLiteral [a.*] Match\n');
    await writeFile(path.join(root, '.env'), 'Literal [a.*] Match=private');
    const tools = new Tools(
      workspace(async () => 'deny'),
      new AbortController().signal,
    );
    assert.equal(
      await tools.execute('search', { query: '[a.*]' }),
      'code.txt:2: Literal [a.*] Match',
    );
  }));

test('requested agent verification runs even when model makes no edits', () =>
  fixture(async ({ root, store, session, workspace }) => {
    const { runAgent } = await import('../dist/agent.js');
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ scripts: { test: 'node -e "process.exit(1)"' } }),
    );
    const backend = {
      model: session.model,
      baseURL: session.backend,
      complete: async () => ({
        message: { role: 'assistant', content: 'Done' },
        usage: {},
        ttftMs: null,
        elapsedMs: 0,
        finishReason: 'stop',
      }),
    };
    const result = await runAgent(
      backend,
      session,
      'Check',
      workspace(async () => 'once'),
      store,
      { signal: new AbortController().signal, context: false, verify: true, maxVerify: 0 },
    );
    assert.equal(result.status, 'verification-failed');
    assert.equal(result.verification.status, 'failed');
  }));
