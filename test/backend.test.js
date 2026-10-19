import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { LMStudioClient } from '../src/backend.js';

async function serverFixture(fn) {
  const server = createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'mock-qwen' }] }));
    } else if (req.url === '/v1/chat/completions') {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write('data: {"choices":[{"delta":{"content":"Hel');
      res.write('lo"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a1","function":{"name":"read_file","arguments":"{\\"path\\":\\""}}]}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"test.txt\\"}"}}]}}]}\n\n');
      res.end('data: [DONE]\n\n');
    } else { res.statusCode = 404; res.end(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await fn(`http://127.0.0.1:${server.address().port}/v1`); }
  finally { await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve())); }
}

test('LM Studio API models and streamed tool calls', async () => serverFixture(async url => {
  const client = new LMStudioClient(url);
  assert.deepEqual(await client.models(), ['mock-qwen']);
  let output = '';
  const response = await client.chat({ model: 'mock-qwen', messages: [{ role: 'user', content: 'hi' }], onText: t => { output += t; } });
  assert.equal(output, 'Hello');
  assert.equal(response.content, 'Hello');
  assert.equal(response.toolCalls.length, 1);
  assert.equal(response.toolCalls[0].function.name, 'read_file');
  assert.equal(JSON.parse(response.toolCalls[0].function.arguments).path, 'test.txt');
}));
