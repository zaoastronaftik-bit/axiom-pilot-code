import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, readdir, mkdir, rename, rm, open, unlink, lstat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { AxiomError, Permissions } from './core.js';
import { Store, writeJSON, readJson } from './storage.js';
import { download, hashFile, type Artifact } from './download.js';
import { extractZip } from './archive.js';
import { minimalEnv, terminateTree } from './command.js';
import { detectHardware, recommend, type RuntimeProfile } from './hardware.js';
import { readGGUF } from './gguf.js';
import { OpenAIBackend } from './backend.js';
export interface RuntimeManifest {
  schema: 1;
  id: string;
  version: string;
  platform: string;
  arch: string;
  source: string;
  license: string;
  licenseUrls: string[];
  assets: Artifact[];
}
export async function runtimeCatalog(): Promise<RuntimeManifest> {
  return JSON.parse(
    await readFile(new URL('../catalogs/runtime.json', import.meta.url), 'utf8'),
  ) as RuntimeManifest;
}
interface Installed {
  schema: 1;
  manifest: RuntimeManifest;
  executable: string;
  files: { relative: string; sha256: string }[];
}
export class RuntimeManager {
  constructor(
    readonly store: Store,
    readonly permissions: Permissions,
  ) {}
  async install(
    signal: AbortSignal,
    onProgress?: (bytes: number, total: number, rate: number) => void,
  ): Promise<Installed> {
    const manifest = await runtimeCatalog();
    if (process.platform !== manifest.platform || process.arch !== manifest.arch)
      throw new AxiomError(
        'RUNTIME_PLATFORM',
        'Managed binary installer currently targets Windows x64 CUDA only; Linux/macOS acceptance is pending',
      );
    const root = path.join(this.store.root, 'runtimes');
    const target = path.join(root, manifest.id);
    await this.permissions.require({
      kind: 'download',
      target: manifest.id,
      cwd: root,
      detail: JSON.stringify(
        {
          source: manifest.source,
          bytes: manifest.assets.reduce((n, a) => n + a.size, 0),
          path: target,
          license: manifest.license,
          licenseUrls: manifest.licenseUrls,
          assets: manifest.assets,
          remove: 'pilotcode runtime remove',
        },
        null,
        2,
      ),
    });
    signal.throwIfAborted();
    await mkdir(root, { recursive: true, mode: 0o700 });
    const lock = await open(path.join(root, 'install.lock'), 'wx').catch(() => {
      throw new AxiomError(
        'RUNTIME_LOCK',
        'Another installation is active or stale install.lock needs inspection',
      );
    });
    const stage = path.join(root, '.stage-' + randomUUID());
    try {
      await mkdir(stage, { mode: 0o700 });
      for (const artifact of manifest.assets) {
        const archive = path.join(root, 'downloads', artifact.name);
        await download(artifact, archive, { signal, ...(onProgress ? { onProgress } : {}) });
        await extractZip(archive, stage, signal);
      }
      const files: Installed['files'] = [];
      let executable = '';
      const scan = async (dir: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const file = path.join(dir, entry.name);
          if (entry.isDirectory()) await scan(file);
          else {
            files.push({ relative: path.relative(stage, file), sha256: await hashFile(file) });
            if (entry.name === 'llama-server.exe') executable = path.relative(stage, file);
          }
        }
      };
      await scan(stage);
      if (!executable) throw new AxiomError('RUNTIME_LAYOUT', 'Archive has no llama-server.exe');
      const fh = await open(path.join(stage, executable), 'r');
      try {
        const header = Buffer.alloc(4096);
        await fh.read(header, 0, header.length, 0);
        const offset = header.readUInt32LE(0x3c);
        if (
          header.toString('ascii', 0, 2) !== 'MZ' ||
          offset + 6 > header.length ||
          header.toString('ascii', offset, offset + 4) !== 'PE\0\0' ||
          header.readUInt16LE(offset + 4) !== 0x8664
        )
          throw new AxiomError('RUNTIME_ARCH', 'llama-server is not Windows PE x64');
      } finally {
        await fh.close();
      }
      const record: Installed = { schema: 1, manifest, executable, files };
      await writeJSON(path.join(stage, 'installed.json'), record);
      try {
        await lstat(target);
        throw new AxiomError(
          'RUNTIME_EXISTS',
          'Runtime already installed. Verify it or remove explicitly before reinstalling',
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      await rename(stage, target);
      await writeJSON(path.join(root, 'active.json'), { schema: 1, id: manifest.id });
      return record;
    } finally {
      await rm(stage, { recursive: true, force: true });
      await lock.close();
      await unlink(path.join(root, 'install.lock')).catch(() => {});
    }
  }
  async installed(): Promise<{ record: Installed; dir: string }> {
    const active = await readJson<{ id: string } | null>(
      path.join(this.store.root, 'runtimes', 'active.json'),
      null,
    );
    if (!active || !/^[a-zA-Z0-9._-]+$/.test(active.id))
      throw new AxiomError('RUNTIME_MISSING', 'Install first: pilotcode runtime install');
    const dir = path.join(this.store.root, 'runtimes', active.id);
    const record = await readJson<Installed | null>(path.join(dir, 'installed.json'), null);
    if (!record || record.schema !== 1)
      throw new AxiomError('RUNTIME_MANIFEST', 'Missing runtime manifest');
    return { record, dir };
  }
  async verify(): Promise<string> {
    const { record, dir } = await this.installed();
    for (const file of record.files) {
      const target = path.resolve(dir, file.relative);
      if (!target.startsWith(dir + path.sep) || (await hashFile(target)) !== file.sha256)
        throw new AxiomError('RUNTIME_INTEGRITY', 'Installed runtime checksum mismatch');
    }
    return 'All installed runtime files match their recorded SHA256';
  }
  async processRecords(): Promise<
    { file: string; pid: number; ownerPid: number; alive: boolean; ownerAlive: boolean }[]
  > {
    const dir = path.join(this.store.root, 'runtimes');
    const result = [];
    for (const file of await readdir(dir).catch(() => [] as string[])) {
      if (!/^process-\d+\.json$/.test(file)) continue;
      const r = await readJson<{ pid: number; ownerPid: number } | null>(
        path.join(dir, file),
        null,
      );
      if (
        !r ||
        !Number.isSafeInteger(r.pid) ||
        r.pid < 1 ||
        !Number.isSafeInteger(r.ownerPid) ||
        r.ownerPid < 1
      )
        continue;
      const alive = (pid: number): boolean => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (e) {
          return (e as NodeJS.ErrnoException).code !== 'ESRCH';
        }
      };
      result.push({
        file,
        pid: r.pid,
        ownerPid: r.ownerPid,
        alive: alive(r.pid),
        ownerAlive: alive(r.ownerPid),
      });
    }
    return result;
  }
  async cleanupStale(): Promise<string[]> {
    const removed = [];
    for (const record of await this.processRecords()) {
      // A live/reused PID is never killed or assumed owned based on a stale JSON file.
      if (record.alive || record.ownerAlive) continue;
      await unlink(path.join(this.store.root, 'runtimes', record.file));
      removed.push(record.file);
    }
    return removed;
  }
  async remove(): Promise<void> {
    const { dir } = await this.installed();
    if ((await this.processRecords()).some((r) => r.alive || r.ownerAlive))
      throw new AxiomError(
        'RUNTIME_BUSY',
        'A recorded process is still alive; stop the owning CLI and inspect runtime status first',
      );
    await this.permissions.require({
      kind: 'write',
      target: dir,
      cwd: this.store.root,
      detail: `Remove installed runtime directory ${dir}. Models and download cache are retained.`,
    });
    await rm(dir, { recursive: true });
    await unlink(path.join(this.store.root, 'runtimes', 'active.json'));
  }
}
export class NativeRuntime {
  private child: ChildProcess | null = null;
  private logs = '';
  private recordFile: string | null = null;
  readonly key = randomBytes(32).toString('hex');
  async start(
    manager: RuntimeManager,
    modelFile: string,
    options: {
      signal: AbortSignal;
      context?: number;
      gpuLayers?: number;
      cpu?: boolean;
      onLog?: (line: string) => void;
    },
  ): Promise<{ backend: OpenAIBackend; profile: RuntimeProfile; gpuEvidence: string[] }> {
    const { record, dir } = await manager.installed();
    await manager.verify();
    const gguf = await readGGUF(modelFile);
    const hardware = await detectHardware();
    if (!hardware.gpus.length && !options.cpu)
      throw new AxiomError(
        'GPU_UNAVAILABLE',
        'No measured NVIDIA GPU. Use --cpu explicitly for CPU inference',
      );
    const profile = recommend(hardware, gguf, options);
    const port = await freePort();
    const alias = path.basename(modelFile, '.gguf');
    const executable = path.join(dir, record.executable);
    const args = [
      '--model',
      modelFile,
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--ctx-size',
      String(profile.context),
      '--parallel',
      '1',
      '--threads',
      String(profile.threads),
      '--gpu-layers',
      String(profile.gpuLayers),
      '--split-mode',
      'none',
      '--main-gpu',
      String(profile.gpuIndex),
      '--fit',
      'off',
      '--cache-ram',
      '0',
      '--no-context-shift',
      '--no-agent',
      '--jinja',
      '--offline',
      '--no-webui',
      '--alias',
      alias,
    ];
    options.signal.throwIfAborted();
    this.child = spawn(executable, args, {
      cwd: dir,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: { ...minimalEnv(), LLAMA_API_KEY: this.key },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let exit: string | null = null;
    this.child.once('error', (e) => {
      exit = e.message;
    });
    this.child.once('exit', (code, sig) => {
      exit = `exit=${code}, signal=${sig}`;
    });
    const capture = (chunk: Buffer): void => {
      const value = chunk.toString().replaceAll(this.key, '[REDACTED]');
      this.logs = (this.logs + value).slice(-32768);
      options.onLog?.(value);
    };
    this.child.stdout?.on('data', capture);
    this.child.stderr?.on('data', capture);
    this.recordFile = path.join(manager.store.root, 'runtimes', `process-${process.pid}.json`);
    await writeJSON(this.recordFile, {
      schema: 1,
      pid: this.child.pid,
      ownerPid: process.pid,
      port,
      startedAt: new Date().toISOString(),
      executable,
    });
    const backend = new OpenAIBackend(`http://127.0.0.1:${port}/v1`, alias, 1024, 42, this.key);
    const deadline = Date.now() + 180000;
    try {
      while (Date.now() < deadline) {
        options.signal.throwIfAborted();
        if (exit !== null)
          throw new AxiomError(
            /out of memory|alloc.*fail|cuda.*memory/i.test(this.logs)
              ? 'RUNTIME_OOM'
              : 'RUNTIME_EXIT',
            `llama-server stopped: ${exit}\n${this.logs.slice(-3000)}`,
          );
        try {
          const response = await fetch(`http://127.0.0.1:${port}/v1/models`, {
            headers: { Authorization: `Bearer ${this.key}` },
            signal: AbortSignal.any([options.signal, AbortSignal.timeout(1000)]),
            redirect: 'error',
          });
          if (response.ok) {
            const data = (await response.json()) as { data?: { id: string }[] };
            if (data.data?.some((m) => m.id === alias)) {
              const evidence = this.logs
                .split('\n')
                .filter((l) => /offloaded \d+\/\d+ layers|CUDA.*buffer size/.test(l));
              if (profile.gpuLayers > 0 && !this.logs.match(/offloaded [1-9]\d*\/\d+ layers/))
                throw new AxiomError(
                  'GPU_UNCONFIRMED',
                  'Server is ready but GPU offload could not be confirmed in allocation logs',
                );
              return { backend, profile, gpuEvidence: evidence };
            }
          }
        } catch (e) {
          if (e instanceof AxiomError) throw e;
        }
        await delay(250, undefined, { signal: options.signal });
      }
      throw new AxiomError('RUNTIME_TIMEOUT', 'Readiness timeout; inspect runtime logs');
    } catch (e) {
      await this.stop();
      throw e;
    }
  }
  async stop(): Promise<void> {
    if (this.child) {
      await terminateTree(this.child);
      this.child = null;
    }
    if (this.recordFile) {
      await unlink(this.recordFile).catch(() => {});
      this.recordFile = null;
    }
  }
}
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new AxiomError('PORT', 'Cannot allocate port');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  return port;
}
