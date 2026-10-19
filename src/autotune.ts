import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { type Backend, Permissions } from './core.js';
import { Store, writeJSON } from './storage.js';
import { detectHardware } from './hardware.js';
export async function calibrate(
  backend: Backend,
  store: Store,
  permissions: Permissions,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  await permissions.require({
    kind: 'command',
    target: 'autotune calibration',
    cwd: process.cwd(),
    detail: `Run two short inference samples on ${backend.baseURL} / ${backend.model}; results stay local. No speedup is assumed.`,
  });
  const before = await detectHardware();
  const samples = [];
  for (const prompt of [
    'Write a TypeScript function that sums an array of numbers. Return only code.',
    'Explain in three sentences how a hash map handles collisions.',
  ]) {
    const reply = await backend.complete([{ role: 'user', content: prompt }], [], signal, () => {});
    samples.push({
      ttftMs: reply.ttftMs,
      elapsedMs: reply.elapsedMs,
      promptTokens: reply.usage.prompt_tokens ?? null,
      completionTokens: reply.usage.completion_tokens ?? null,
      tokensPerSecond:
        reply.usage.completion_tokens && reply.ttftMs !== null && reply.elapsedMs > reply.ttftMs
          ? Math.max(0, reply.usage.completion_tokens - 1) /
            ((reply.elapsedMs - reply.ttftMs) / 1000)
          : null,
      prefillTokensPerSecond: null,
      prefillNote: 'TTFT includes queue/HTTP overhead; no server prefill timing reported',
      cliRssBytes: process.memoryUsage().rss,
    });
  }
  const result = {
    schema: 1,
    at: new Date().toISOString(),
    model: backend.model,
    backend: backend.baseURL,
    hardwareBefore: before,
    hardwareAfter: await detectHardware(),
    samples,
    swap: null,
    runtimeRssBytes: null,
    notes: [
      'GPU memory is sampled before/after, not peak. CLI RSS is not model memory.',
      'Seed/model/context must be held fixed for comparisons. No automatic settings changes.',
    ],
  };
  await writeJSON(path.join(store.root, 'calibration', randomUUID() + '.json'), result);
  return result;
}
