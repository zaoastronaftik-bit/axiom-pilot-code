import { readFile, readdir, mkdir, copyFile, rename, rm, lstat } from 'node:fs/promises';
import path from 'node:path';
import { AxiomError, Permissions } from './core.js';
import { Store, writeJSON, readJson } from './storage.js';
import { download, hashFile, type Artifact } from './download.js';
import { readGGUF, type GGUF } from './gguf.js';
export interface ModelRecord extends Artifact {
  schema: 1;
  id: string;
  source: string;
  revision: string;
  license: string;
  licenseUrl: string;
  quantization: string;
  provenance: string;
  metadata?: GGUF;
}
export async function modelCatalog(): Promise<ModelRecord[]> {
  return JSON.parse(
    await readFile(new URL('../catalogs/models.json', import.meta.url), 'utf8'),
  ) as ModelRecord[];
}
export class ModelManager {
  constructor(
    readonly store: Store,
    readonly permissions: Permissions,
  ) {}
  dir(id: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(id))
      throw new AxiomError('MODEL_ID', 'Invalid model id');
    return path.join(this.store.root, 'models', id);
  }
  async search(query = ''): Promise<ModelRecord[]> {
    return (await modelCatalog()).filter((m) =>
      (m.id + ' ' + m.source).toLowerCase().includes(query.toLowerCase()),
    );
  }
  async list(): Promise<ModelRecord[]> {
    const names = await readdir(path.join(this.store.root, 'models')).catch(() => [] as string[]);
    const result = [];
    for (const id of names) {
      try {
        result.push(await this.get(id));
      } catch {
        /* partial downloads are not installed models */
      }
    }
    return result;
  }
  async get(id: string): Promise<ModelRecord> {
    const m = await readJson<ModelRecord | null>(path.join(this.dir(id), 'model.json'), null);
    if (
      !m ||
      m.schema !== 1 ||
      m.id !== id ||
      path.basename(m.name) !== m.name ||
      !m.name.endsWith('.gguf')
    )
      throw new AxiomError('MODEL_MISSING', `Model ${id} is not installed`);
    return m;
  }
  async file(id: string): Promise<string> {
    const m = await this.get(id);
    return path.join(this.dir(id), m.name);
  }
  async verify(id: string): Promise<GGUF> {
    const m = await this.get(id);
    const file = await this.file(id);
    if ((await lstat(file)).size !== m.size || (await hashFile(file)) !== m.sha256)
      throw new AxiomError('MODEL_INTEGRITY', 'Model SHA256/size mismatch');
    return readGGUF(file);
  }
  async install(
    id: string,
    signal: AbortSignal,
    onProgress?: (bytes: number, total: number, rate: number) => void,
  ): Promise<ModelRecord> {
    const model = (await modelCatalog()).find((m) => m.id === id);
    if (!model)
      throw new AxiomError(
        'MODEL_SOURCE',
        'Unknown curated model. Use models search or explicitly import a local GGUF',
      );
    const dir = this.dir(id);
    await this.permissions.require({
      kind: 'download',
      target: id,
      cwd: this.store.root,
      detail: JSON.stringify(
        { ...model, path: dir, remove: `pilotcode models remove ${id}` },
        null,
        2,
      ),
    });
    signal.throwIfAborted();
    await download(model, path.join(dir, model.name), {
      signal,
      ...(onProgress ? { onProgress } : {}),
    });
    const metadata = await readGGUF(path.join(dir, model.name));
    const record = { ...model, metadata };
    await writeJSON(path.join(dir, 'model.json'), record);
    return record;
  }
  async import(
    file: string,
    id: string,
    license: string,
    source: string,
    signal: AbortSignal,
  ): Promise<ModelRecord> {
    if (!license.trim() || !source.trim())
      throw new AxiomError(
        'MODEL_PROVENANCE',
        'Explicit --license and --source are required for imports',
      );
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new AxiomError('MODEL_FILE', 'Import requires a regular local file');
    const dir = this.dir(id);
    const name = id + '.gguf';
    try {
      await lstat(dir);
      throw new AxiomError('MODEL_EXISTS', 'Import target exists; choose a new id');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    await this.permissions.require({
      kind: 'download',
      target: id,
      cwd: this.store.root,
      detail: JSON.stringify(
        { operation: 'copy local GGUF', source, file, license, bytes: stat.size, destination: dir },
        null,
        2,
      ),
    });
    signal.throwIfAborted();
    const metadata = await readGGUF(file);
    await mkdir(path.dirname(dir), { recursive: true, mode: 0o700 });
    await mkdir(dir, { mode: 0o700 });
    const temp = path.join(dir, name + '.part');
    await copyFile(file, temp);
    signal.throwIfAborted();
    const copied = await lstat(temp);
    if (copied.size !== stat.size)
      throw new AxiomError('MODEL_CONFLICT', 'Source size changed during import');
    const digest = await hashFile(temp);
    if ((await hashFile(file)) !== digest)
      throw new AxiomError('MODEL_CONFLICT', 'Source changed during import');
    await rename(temp, path.join(dir, name));
    const model: ModelRecord = {
      schema: 1,
      id,
      name,
      url: '',
      size: stat.size,
      sha256: digest,
      source,
      revision: 'local-import',
      license,
      licenseUrl: '',
      quantization: String(metadata.metadata['general.file_type'] ?? 'unknown'),
      provenance: 'User-supplied local file and license; rights not independently verified',
      metadata,
    };
    await writeJSON(path.join(dir, 'model.json'), model);
    return model;
  }
  async remove(id: string): Promise<void> {
    const record = await this.get(id);
    await this.permissions.require({
      kind: 'write',
      target: this.dir(id),
      cwd: this.store.root,
      detail: `Delete managed model ${id}, ${record.size} bytes. Imported originals are retained.`,
    });
    await rm(this.dir(id), { recursive: true });
  }
}
