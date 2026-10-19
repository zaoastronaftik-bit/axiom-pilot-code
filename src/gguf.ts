import { open } from 'node:fs/promises';
import { AxiomError } from './core.js';
export interface GGUF {
  version: number;
  tensors: number;
  metadata: Record<string, string | number | boolean>;
  fileBytes: number;
}
export async function readGGUF(file: string): Promise<GGUF> {
  const handle = await open(file, 'r');
  try {
    const size = (await handle.stat()).size;
    if (size < 24) throw new AxiomError('GGUF', 'File is too small');
    const buffer = Buffer.alloc(Math.min(size, 16 * 1024 * 1024));
    await handle.read(buffer, 0, buffer.length, 0);
    let pos = 0;
    const need = (n: number): void => {
      if (n < 0 || pos + n > buffer.length)
        throw new AxiomError('GGUF', 'Invalid or oversized metadata (16 MB limit)');
    };
    const u32 = (): number => {
      need(4);
      const n = buffer.readUInt32LE(pos);
      pos += 4;
      return n;
    };
    const u64 = (): number => {
      need(8);
      const b = buffer.readBigUInt64LE(pos);
      pos += 8;
      if (b > BigInt(Number.MAX_SAFE_INTEGER)) throw new AxiomError('GGUF', 'Integer overflow');
      return Number(b);
    };
    const str = (): string => {
      const n = u64();
      need(n);
      const s = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(pos, pos + n));
      pos += n;
      return s;
    };
    need(4);
    if (buffer.toString('ascii', 0, 4) !== 'GGUF') throw new AxiomError('GGUF', 'Not a GGUF file');
    pos = 4;
    const version = u32();
    if (version !== 2 && version !== 3) throw new AxiomError('GGUF', 'Only GGUF v2/v3 supported');
    const tensors = u64(),
      count = u64();
    if (count > 100000 || tensors > 1000000)
      throw new AxiomError('GGUF', 'Unreasonable metadata/tensor count');
    const value = (type: number, depth = 0): string | number | boolean | undefined => {
      if (depth > 1) throw new AxiomError('GGUF', 'Nested arrays not supported');
      if (type === 8) return str();
      if (type === 9) {
        const sub = u32(),
          n = u64();
        if (n > 1000000) throw new AxiomError('GGUF', 'Array limit');
        for (let i = 0; i < n; i++) value(sub, depth + 1);
        return undefined;
      }
      const sizes: Record<number, number> = {
        0: 1,
        1: 1,
        2: 2,
        3: 2,
        4: 4,
        5: 4,
        6: 4,
        7: 1,
        10: 8,
        11: 8,
        12: 8,
      };
      const len = sizes[type];
      if (!len) throw new AxiomError('GGUF', 'Unknown metadata type');
      need(len);
      let result: number | boolean;
      if (type === 7) result = buffer[pos] !== 0;
      else if (type === 6) result = buffer.readFloatLE(pos);
      else if (type === 12) result = buffer.readDoubleLE(pos);
      else if (type === 10 || type === 11) {
        const n = type === 10 ? buffer.readBigUInt64LE(pos) : buffer.readBigInt64LE(pos);
        result = Number(n);
        if (!Number.isSafeInteger(result)) throw new AxiomError('GGUF', 'Integer overflow');
      } else
        result = [1, 3, 5].includes(type)
          ? buffer.readIntLE(pos, len)
          : buffer.readUIntLE(pos, len);
      pos += len;
      return result;
    };
    const metadata: GGUF['metadata'] = {};
    for (let i = 0; i < count; i++) {
      const key = str(),
        v = value(u32());
      if (
        v !== undefined &&
        (key.startsWith('general.') ||
          /\.(?:block_count|embedding_length|context_length|head_count|head_count_kv|key_length|value_length)$/.test(
            key,
          ))
      )
        metadata[key] = v;
    }
    return { version, tensors, metadata, fileBytes: size };
  } finally {
    await handle.close();
  }
}
