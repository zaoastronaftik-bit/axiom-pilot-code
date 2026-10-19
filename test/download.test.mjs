import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { download, trustedDownloadURL } from '../dist/download.js';
import { sha256 } from '../dist/core.js';
import { writeJSON } from '../dist/storage.js';
import { archivePath } from '../dist/archive.js';
import { recommend } from '../dist/hardware.js';
async function fixture(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'axiom-dl-'));
  try {
    await fn(path.join(dir, 'model.gguf'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const bytes = Buffer.from('actual fixture bytes');
const artifact = {
  url: 'https://huggingface.co/Qwen/test/resolve/pinned/test.gguf',
  name: 'test.gguf',
  size: bytes.length,
  sha256: sha256(bytes),
};
test('resumes using validated HTTP range then checks SHA256', () =>
  fixture(async (dest) => {
    await writeFile(dest + '.part', bytes.subarray(0, 7));
    await writeJSON(dest + '.part.json', artifact);
    await download(artifact, dest, {
      signal: new AbortController().signal,
      fetcher: async (_url, o) => {
        assert.equal(o.headers.Range, 'bytes=7-');
        return new Response(bytes.subarray(7), {
          status: 206,
          headers: { 'content-range': `bytes 7-${bytes.length - 1}/${bytes.length}` },
        });
      },
    });
    assert.deepEqual(await readFile(dest), bytes);
  }));
test('ignored range restarts safely without appending duplicate bytes', () =>
  fixture(async (dest) => {
    await writeFile(dest + '.part', bytes.subarray(0, 7));
    await writeJSON(dest + '.part.json', artifact);
    await download(artifact, dest, {
      signal: new AbortController().signal,
      fetcher: async () => new Response(bytes),
    });
    assert.deepEqual(await readFile(dest), bytes);
  }));
test('rejects wrong range, digest, oversized payload and redirect host', async () => {
  await fixture(async (dest) => {
    await assert.rejects(
      download(artifact, dest, {
        signal: new AbortController().signal,
        fetcher: async () =>
          new Response(bytes, { status: 206, headers: { 'content-range': 'bytes 2-4/5' } }),
      }),
      { code: 'DOWNLOAD_RANGE' },
    );
  });
  await fixture(async (dest) => {
    await assert.rejects(
      download({ ...artifact, sha256: '0'.repeat(64) }, dest, {
        signal: new AbortController().signal,
        fetcher: async () => new Response(bytes),
      }),
      { code: 'CHECKSUM' },
    );
    await assert.rejects(readFile(dest));
  });
  await fixture(async (dest) => {
    await assert.rejects(
      download(artifact, dest, {
        signal: new AbortController().signal,
        fetcher: async () => new Response(Buffer.alloc(100)),
      }),
      { code: 'DOWNLOAD_SIZE' },
    );
  });
  assert.throws(() => trustedDownloadURL('http://huggingface.co/x'));
  assert.throws(() => trustedDownloadURL('https://evil.example/x'));
});
for (const name of ['../x', 'a/../../x', 'C:/x', '/absolute', 'a\\x', 'foo/CON.txt', 'a:ads'])
  test(`archive rejects ${name}`, () => assert.throws(() => archivePath(name)));
test('hardware estimator refuses oversize and never invents GPU', () => {
  const h = { gpus: [], ramFree: 32 * 1024 ** 3, cores: 12 };
  const gguf = {
    fileBytes: 5 * 1024 ** 3,
    metadata: {
      'general.architecture': 'qwen2',
      'qwen2.block_count': 28,
      'qwen2.embedding_length': 3584,
      'qwen2.attention.head_count': 28,
      'qwen2.attention.head_count_kv': 4,
    },
  };
  assert.equal(recommend(h, gguf).gpuLayers, 0);
  assert.throws(() => recommend({ ...h, ramFree: 2 * 1024 ** 3 }, gguf), { code: 'MEMORY' });
  assert.throws(() => recommend(h, gguf, { gpuLayers: 20 }), { code: 'GPU_UNAVAILABLE' });
});

test('a complete cached artifact is hashed and reused without network', () =>
  fixture(async (dest) => {
    await writeFile(dest, bytes);
    await download(artifact, dest, {
      signal: new AbortController().signal,
      fetcher: async () => assert.fail('network must not be used'),
    });
    assert.deepEqual(await readFile(dest), bytes);
  }));
