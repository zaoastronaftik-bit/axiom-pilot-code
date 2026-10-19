import test from 'node:test';
import assert from 'node:assert/strict';
import { LMStudioClient } from '../dist/backend.js';
import { DeviceAuth } from '../dist/auth.js';
const event = (data) => 'data: ' + JSON.stringify(data) + '\r\n\r\n';
function streamed(parts) {
  return new Response(
    new ReadableStream({
      start(c) {
        for (const part of parts) c.enqueue(new TextEncoder().encode(part));
        c.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
test('SSE arbitrary byte boundaries and interleaved tools are reconstructed', async () => {
  const raw =
    event({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 1, id: 'b', function: { name: 'read_', arguments: '{"path":' } },
              { index: 0, id: 'a', function: { name: 'list_files', arguments: '{}' } },
            ],
          },
        },
      ],
    }) +
    event({
      choices: [
        {
          delta: { tool_calls: [{ index: 1, function: { name: 'file', arguments: '"a.txt"}' } }] },
        },
      ],
    }) +
    'data: [DONE]\r\n\r\n';
  const client = new LMStudioClient('http://127.0.0.1/v1', undefined, async () =>
    streamed([...raw]),
  );
  const r = await client.chat({ model: 'm', messages: [] });
  assert.deepEqual(
    r.toolCalls.map((c) => c.id),
    ['a', 'b'],
  );
  assert.equal(r.toolCalls[1].function.name, 'read_file');
  assert.equal(JSON.parse(r.toolCalls[1].function.arguments).path, 'a.txt');
});
test('SSE truncated, malformed and token-limit responses fail closed', async () => {
  for (const [raw, code] of [
    [event({ choices: [{ delta: { content: 'partial' } }] }), 'STREAM_INCOMPLETE'],
    ['data: {bad}\n\n', 'SSE_JSON'],
    [event({ choices: [{ delta: {}, finish_reason: 'length' }] }), 'TOKEN_LIMIT'],
  ]) {
    const c = new LMStudioClient('http://127.0.0.1/v1', undefined, async () => streamed([raw]));
    await assert.rejects(c.chat({ model: 'm', messages: [] }), { code });
  }
});
test('non-loopback HTTP backend is rejected', () =>
  assert.throws(() => new LMStudioClient('http://example.com/v1'), { code: 'BACKEND_URL' }));
test('device code flow obeys contract, waits interval, never approves itself', async () => {
  let saved = null;
  const requests = [];
  const secret = {
    get: async () => saved,
    set: async (v) => {
      saved = v;
    },
    delete: async () => {
      saved = null;
    },
  };
  const api = async (url, init) => {
    requests.push({ url, init, at: Date.now() });
    if (url.endsWith('action=start'))
      return Response.json({
        deviceCode: 'A'.repeat(43),
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://example.com/?device=ABCD-EFGH',
        expiresIn: 600,
        interval: 1,
      });
    if (url.endsWith('action=poll'))
      return Response.json({ status: 'authorized', accessToken: 'axiom_cli_' + 'B'.repeat(43) });
    if (url.endsWith('action=revoke')) return Response.json({ revoked: true });
    return Response.json({ authenticated: true, plan: 'free', userId: 'u', tokenId: 't' });
  };
  const client = new DeviceAuth('https://api.example.com', secret, api);
  let shown = false;
  await client.login(new AbortController().signal, async (code) => {
    shown = code === 'ABCD-EFGH';
  });
  assert.ok(shown);
  assert.ok(requests[1].at - requests[0].at >= 950);
  assert.ok(!requests.some((r) => r.url.includes('approve')));
  assert.equal(JSON.parse(requests[1].init.body).deviceCode, 'A'.repeat(43));
  assert.equal((await client.whoami(new AbortController().signal)).plan, 'free');
  await client.logout(new AbortController().signal);
  assert.equal(saved, null);
});
test('device cancellation prevents poll and unreachable service never simulates login', async () => {
  let calls = 0;
  const secrets = {
    get: async () => null,
    set: async () => assert.fail('no token'),
    delete: async () => {},
  };
  const c = new AbortController();
  const client = new DeviceAuth('https://api.example.com', secrets, async () => {
    calls++;
    return Response.json({
      deviceCode: 'A'.repeat(43),
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://example.com',
      expiresIn: 600,
      interval: 5,
    });
  });
  await assert.rejects(client.login(c.signal, async () => c.abort()));
  assert.equal(calls, 1);
  const unavailable = new DeviceAuth('https://api.example.com', secrets, async () => {
    throw new Error('offline');
  });
  await assert.rejects(
    unavailable.login(new AbortController().signal, async () => {}),
    { code: 'ACCOUNT_UNAVAILABLE' },
  );
});
