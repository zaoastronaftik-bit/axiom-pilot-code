import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newSession } from '../src/storage.js';
import { processPrompt } from '../src/agent.js';

test('agent creates a file after user approval and persists conversation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilotcode-agent-'));
  const session = newSession(root, 'mock-model', 'fast');
  let requests = 0;
  const client = { chat: async ({ messages, onText }) => {
    requests++;
    if (requests === 1) {
      assert.equal(messages.at(-1).content, 'create hello.txt');
      return { content: '', toolCalls: [{ id: 'call_1', function: { name: 'write_file', arguments: '{"path":"hello.txt","content":"Hello from AI"}' } }] };
    }
    assert.equal(messages.at(-1).role, 'tool');
    onText('Created hello.txt.');
    return { content: 'Created hello.txt.', toolCalls: [] };
  }};
  try {
    const result = await processPrompt({ client, session, prompt: 'create hello.txt', root, ask: async () => true, log: () => {}, write: () => {} });
    assert.equal(result.steps, 1);
    assert.equal(await readFile(join(root, 'hello.txt'), 'utf8'), 'Hello from AI');
    assert.equal(session.history.length, 2);
    assert.equal(session.history[0].role, 'user');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('deep uses same model for plan and execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilotcode-deep-'));
  const session = newSession(root, 'chosen-model', 'deep');
  const models = [];
  const client = { chat: async ({ model, tools, onText }) => {
    models.push(model);
    if (!tools?.length) return { content: 'Inspect project and implement.', toolCalls: [] };
    onText('Done');
    return { content: 'Done', toolCalls: [] };
  }};
  try {
    await processPrompt({ client, session, prompt: 'design site', root, ask: async () => false, log: () => {}, write: () => {} });
    assert.deepEqual(models, ['chosen-model', 'chosen-model']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
