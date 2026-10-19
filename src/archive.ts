import yauzl, { type Entry } from 'yauzl';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { AxiomError } from './core.js';
export function archivePath(name: string): string {
  if (
    !name ||
    /[\\:\0]/.test(name) ||
    name.startsWith('/') ||
    name
      .split('/')
      .some(
        (p) =>
          p === '..' ||
          p === '.' ||
          /[. ]$/.test(p) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),
      )
  )
    throw new AxiomError('ZIP_PATH', 'Unsafe archive entry');
  return name;
}
export async function extractZip(
  archive: string,
  target: string,
  signal: AbortSignal,
): Promise<void> {
  await mkdir(target, { recursive: true, mode: 0o700 });
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.open(
      archive,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (e, z) => (e ? reject(e) : resolve(z!)),
    ),
  );
  let total = 0,
    count = 0;
  const seen = new Set<string>();
  await new Promise<void>((resolve, reject) => {
    const fail = (e: unknown): void => {
      zip.close();
      reject(e);
    };
    zip.on('error', fail);
    zip.on('end', resolve);
    zip.on('entry', (entry: Entry) => {
      void (async () => {
        signal.throwIfAborted();
        const name = archivePath(entry.fileName);
        const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
        if ((mode && mode !== 0x8000 && mode !== 0x4000) || entry.generalPurposeBitFlag & 1)
          throw new AxiomError(
            'ZIP_TYPE',
            'Links, special files and encrypted entries are forbidden',
          );
        if (seen.has(name.toLowerCase()))
          throw new AxiomError('ZIP_DUPLICATE', 'Duplicate archive path');
        seen.add(name.toLowerCase());
        total += entry.uncompressedSize;
        if (++count > 5000 || total > 4_000_000_000 || entry.uncompressedSize > 2_000_000_000)
          throw new AxiomError('ZIP_SIZE', 'Archive exceeds extraction budget');
        const dest = path.join(target, name);
        if (name.endsWith('/')) {
          await mkdir(dest, { recursive: true });
          zip.readEntry();
          return;
        }
        await mkdir(path.dirname(dest), { recursive: true });
        const output = await open(dest, 'wx', 0o600);
        try {
          const stream = await new Promise<NodeJS.ReadableStream>((res, rej) =>
            zip.openReadStream(entry, (e, s) => (e ? rej(e) : res(s!))),
          );
          let bytes = 0;
          const limiter = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              bytes += chunk.length;
              callback(
                bytes > entry.uncompressedSize
                  ? new AxiomError('ZIP_SIZE', 'Expanded size mismatch')
                  : null,
                chunk,
              );
            },
          });
          await pipeline(stream, limiter, output.createWriteStream(), {
            signal,
          });
        } finally {
          await output.close();
        }
        zip.readEntry();
      })().catch(fail);
    });
    zip.readEntry();
  });
}
