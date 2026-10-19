import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Workspace } from '../dist/workspace.js';
import { Store } from '../dist/storage.js';
import { Permissions } from '../dist/core.js';
import { discoverChecks, verify } from '../dist/verify.js';
import { extractZip } from '../dist/archive.js';
import { readGGUF } from '../dist/gguf.js';
const repo = fileURLToPath(new URL('../', import.meta.url));
const signal = new AbortController().signal;
async function temp(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'axiom-integration-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
for (const language of ['node', 'typescript', 'python']) {
  test(`Verify observes real ${language} failure, then real successful repair`, () =>
    temp(async (dir) => {
      const root = path.join(dir, 'project');
      await cp(path.join(repo, 'fixtures', language), root, { recursive: true });
      const w = new Workspace(
        root,
        new Permissions(async () => 'once'),
        new Store(path.join(dir, 'state')),
        'fixture',
      );
      const checks = await discoverChecks(w);
      assert.equal(checks.length, 1);
      if (language === 'typescript') {
        // Use the repository's locked compiler without installing anything in the fixture.
        checks[0].args[0] = path.join(repo, 'node_modules/typescript/bin/tsc');
      }
      const failed = await verify(w, signal, checks);
      assert.equal(failed.status, 'failed', JSON.stringify(failed));
      if (language === 'typescript') {
        assert.ok(failed.results[0].diagnostics.some((d) => d.message.includes('TS2322')));
        await w.write('index.ts', 'export const count: number = 1;\n');
      } else if (language === 'node')
        await w.write('sum.mjs', 'export const sum = (a, b) => a + b;\n');
      else await w.write('calculate.py', 'def add(a, b):\n    return a + b\n');
      const passed = await verify(w, signal, checks);
      assert.equal(passed.status, 'passed', JSON.stringify(passed));
    }));
}
function zip(entries) {
  const local = [],
    central = [];
  let offset = 0;
  for (const { name, text = 'fixture', mode = 0o100644 } of entries) {
    const n = Buffer.from(name),
      data = Buffer.from(text);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50);
    h.writeUInt16LE(20, 4);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(data.length, 18);
    h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(n.length, 26);
    local.push(h, n, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50);
    c.writeUInt16LE(0x0314, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE((mode << 16) >>> 0, 38);
    c.writeUInt32LE(offset, 42);
    central.push(c, n);
    offset += h.length + n.length + data.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
test('ZIP extraction writes actual bytes and rejects symlinks, duplicate paths and traversal', () =>
  temp(async (dir) => {
    const archive = path.join(dir, 'runtime.zip');
    await writeFile(archive, zip([{ name: 'bin/server.txt', text: 'real extracted bytes' }]));
    await extractZip(archive, path.join(dir, 'good'), signal);
    assert.equal(
      await readFile(path.join(dir, 'good/bin/server.txt'), 'utf8'),
      'real extracted bytes',
    );
    for (const [i, entries] of [
      [{ name: 'link', mode: 0o120777 }],
      [{ name: 'same' }, { name: 'SAME' }],
      [{ name: '../escape' }],
    ].entries()) {
      await writeFile(archive, zip(entries));
      await assert.rejects(extractZip(archive, path.join(dir, `bad${i}`), signal));
    }
  }));
test('GGUF parser accepts a real minimal header and rejects overflow/truncation', () =>
  temp(async (dir) => {
    const file = path.join(dir, 'fixture.gguf');
    const b = Buffer.alloc(24);
    b.write('GGUF');
    b.writeUInt32LE(3, 4);
    await writeFile(file, b);
    assert.equal((await readGGUF(file)).version, 3);
    b.writeBigUInt64LE(2n ** 63n, 16);
    await writeFile(file, b);
    await assert.rejects(readGGUF(file), { code: 'GGUF' });
    await writeFile(file, b.subarray(0, 10));
    await assert.rejects(readGGUF(file), { code: 'GGUF' });
  }));
