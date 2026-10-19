import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSessions, newSession, saveSession } from '../src/storage.js';
import { versionCompare } from '../src/updater.js';

test('session save and resume only same project', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pilotcode-session-'));
  const env = { PILOTCODE_HOME: dir };
  try {
    const session = newSession('/my-project', 'mock', 'fast');
    session.history.push({ role: 'user', content: 'hello' });
    await saveSession(session, env);
    assert.equal((await getSessions('/my-project', env))[0].history[0].content, 'hello');
    assert.deepEqual(await getSessions('/another', env), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('version compare handles patch versions', () => {
  assert.equal(versionCompare('1.2.3', '1.3.0'), -1);
  assert.equal(versionCompare('1.2.3', '1.2.3'), 0);
  assert.equal(versionCompare('2.0.0', '1.9.9'), 1);
});
