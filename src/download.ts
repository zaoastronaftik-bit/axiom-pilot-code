import { createReadStream } from 'node:fs';
import { open, stat, mkdir, rename, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { AxiomError } from './core.js';
import { readJson, writeJSON } from './storage.js';
export interface Artifact {
  url: string;
  size: number;
  sha256: string;
  name: string;
}
export async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export function trustedDownloadURL(input: string): URL {
  const u = new URL(input);
  const h = u.hostname;
  if (
    u.protocol !== 'https:' ||
    u.username ||
    u.password ||
    !(
      h === 'github.com' ||
      h === 'release-assets.githubusercontent.com' ||
      h === 'objects.githubusercontent.com' ||
      h === 'huggingface.co' ||
      h.endsWith('.huggingface.co') ||
      h.endsWith('.hf.co')
    )
  )
    throw new AxiomError(
      'DOWNLOAD_SOURCE',
      'Only HTTPS upstream GitHub/Hugging Face download hosts are allowed',
    );
  return u;
}
export async function download(
  artifact: Artifact,
  destination: string,
  options: {
    signal: AbortSignal;
    onProgress?: (bytes: number, total: number, bytesPerSecond: number) => void;
    fetcher?: typeof fetch;
  },
): Promise<void> {
  if (
    !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
    !Number.isSafeInteger(artifact.size) ||
    artifact.size < 1 ||
    artifact.size > 100_000_000_000
  )
    throw new AxiomError('ARTIFACT', 'Invalid pinned size or SHA256');
  trustedDownloadURL(artifact.url);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const part = destination + '.part',
    meta = part + '.json';
  const lock = await open(part + '.lock', 'wx', 0o600).catch(() => {
    throw new AxiomError(
      'DOWNLOAD_LOCK',
      'Download already active or stale .part.lock exists; inspect before removing',
    );
  });
  try {
    options.signal.throwIfAborted();
    const existing = await stat(destination).catch(() => null);
    if (existing?.size === artifact.size && (await hashFile(destination)) === artifact.sha256) {
      options.onProgress?.(artifact.size, artifact.size, 0);
      return;
    }
    const saved = await readJson<Artifact | null>(meta, null);
    let offset = 0;
    if (
      saved?.sha256 === artifact.sha256 &&
      saved.url === artifact.url &&
      saved.size === artifact.size
    ) {
      try {
        offset = (await stat(part)).size;
      } catch {
        /* new */
      }
    } else {
      await unlink(part).catch(() => {});
      await writeJSON(meta, artifact);
    }
    if (offset > artifact.size) {
      await unlink(part);
      offset = 0;
    }
    let initial = offset;
    const start = performance.now();
    if (offset < artifact.size) {
      let url = artifact.url,
        response: Response | undefined;
      const signal = AbortSignal.any([options.signal, AbortSignal.timeout(24 * 60 * 60 * 1000)]);
      for (let i = 0; i <= 5; i++) {
        response = await (options.fetcher ?? fetch)(trustedDownloadURL(url), {
          redirect: 'manual',
          headers: offset ? { Range: `bytes=${offset}-` } : {},
          signal,
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          await response.body?.cancel();
          if (!location) throw new AxiomError('DOWNLOAD_REDIRECT', 'Missing redirect');
          url = new URL(location, url).href;
          continue;
        }
        break;
      }
      if (!response || ![200, 206].includes(response.status) || !response.body)
        throw new AxiomError('DOWNLOAD_HTTP', `Download HTTP ${response?.status ?? 'none'}`);
      if (response.status === 206) {
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
          response.headers.get('content-range') ?? '',
        );
        if (
          !range ||
          Number(range[1]) !== offset ||
          Number(range[2]) !== artifact.size - 1 ||
          Number(range[3]) !== artifact.size
        ) {
          await response.body.cancel();
          throw new AxiomError('DOWNLOAD_RANGE', 'Invalid Content-Range; refusing corrupt append');
        }
      } else {
        offset = 0;
        initial = 0;
      }
      const file = await open(part, offset ? 'a' : 'w', 0o600);
      const reader = response.body.getReader();
      let lastProgress = 0;
      try {
        for (;;) {
          signal.throwIfAborted();
          const item = await reader.read();
          if (item.done) break;
          if (offset + item.value.length > artifact.size)
            throw new AxiomError('DOWNLOAD_SIZE', 'Upstream exceeded pinned file size');
          await file.writeFile(item.value);
          offset += item.value.length;
          if (performance.now() - lastProgress > 500) {
            options.onProgress?.(
              offset,
              artifact.size,
              (offset - initial) / Math.max(0.001, (performance.now() - start) / 1000),
            );
            lastProgress = performance.now();
          }
        }
        await file.sync();
      } finally {
        await reader.cancel().catch(() => {});
        await file.close();
      }
    }
    if (offset !== artifact.size)
      throw new AxiomError('DOWNLOAD_INCOMPLETE', 'Download incomplete; rerun to resume');
    if ((await hashFile(part)) !== artifact.sha256) {
      await unlink(part);
      throw new AxiomError('CHECKSUM', 'SHA256 mismatch; corrupt data removed');
    }
    options.signal.throwIfAborted();
    await rename(part, destination);
    await unlink(meta).catch(() => {});
    options.onProgress?.(
      artifact.size,
      artifact.size,
      (artifact.size - initial) / Math.max(0.001, (performance.now() - start) / 1000),
    );
  } finally {
    await lock.close();
    await unlink(part + '.lock').catch(() => {});
  }
}
