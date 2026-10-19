import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeTool, projectPath } from '../src/tools.js';

async function fixture(fn) {
  const base = await mkdtemp(join(tmpdir(), 'pilotcode-tests-'));
  const root = join(base, 'project');
  const outside = join(base, 'outside');
  await mkdir(root); await mkdir(outside);
  try { await fn({ base, root, outside }); }
  finally { await rm(base, { recursive: true, force: true }); }
}

test('file tool rejects traversal, absolute paths, and protected files', async () => fixture(async ({ root }) => {
  await assert.rejects(projectPath(root, '../outside/secret.txt'), /escapes/);
  await assert.rejects(projectPath(root, '/tmp/outside'), /relative/);
  await assert.rejects(projectPath(root, '.git/config'), /protected/);
  await assert.rejects(projectPath(root, '.env'), /protected/);
}));

test('file tool does not follow symlinks outside project', async () => fixture(async ({ root, outside }) => {
  await writeFile(join(outside, 'secret.txt'), 'private');
  await symlink(outside, join(root, 'external'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(projectPath(root, 'external/secret.txt'), /escapes/);
  await assert.rejects(projectPath(root, 'external/new.txt', { writing: true }), /escapes/);
}));

test('writes require confirmation, can create nested file and read it', async () => fixture(async ({ base, root }) => {
  const context = { root, env: { PILOTCODE_HOME: join(base, 'data') }, ask: async () => false };
  assert.match(await executeTool('write_file', { path: 'src/index.js', content: 'hello' }, context), /Denied/);
  await assert.rejects(readFile(join(root, 'src/index.js')), /ENOENT/);
  context.ask = async () => true;
  assert.match(await executeTool('write_file', { path: 'src/index.js', content: 'hello' }, context), /created/);
  assert.equal(await executeTool('read_file', { path: 'src/index.js' }, context), 'hello');
  assert.match(await executeTool('write_file', { path: 'src/index.js', content: 'world' }, context), /updated/);
  assert.equal(await readFile(join(root, 'src/index.js'), 'utf8'), 'world');
}));

test('shell command requires approval', async () => fixture(async ({ root }) => {
  const msg = await executeTool('run_command', { command: 'echo ok' }, { root, ask: async () => false });
  assert.match(msg, /Denied/);
}));
