import { mkdir, open, rename, readFile, readdir, lstat, unlink, copyFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { AxiomError, object, sha256, type Message } from './core.js';

export function dataDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PILOTCODE_HOME || env.AXIOM_HOME)
    return path.resolve(env.PILOTCODE_HOME || env.AXIOM_HOME!);
  return process.platform === 'win32'
    ? path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'AxiomPilotCode')
    : path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'axiom-pilot-code');
}
export async function atomicWrite(
  file: string,
  data: string | Uint8Array,
  mode = 0o600,
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, file);
  } finally {
    await unlink(temp).catch(() => {});
  }
}
export const writeJSON = (file: string, data: unknown): Promise<void> =>
  atomicWrite(file, JSON.stringify(data, null, 2) + '\n');
export interface Session {
  schema: 1;
  id: string;
  cwd: string;
  model: string;
  backend: string;
  mode: 'fast' | 'deep';
  messages: Message[];
  createdAt: string;
  updatedAt: string;
  status: string;
}
export function newSession(cwd: string, model: string, backend: string): Session {
  const now = new Date().toISOString();
  return {
    schema: 1,
    id: randomUUID(),
    cwd,
    model,
    backend,
    mode: 'fast',
    messages: [],
    createdAt: now,
    updatedAt: now,
    status: 'idle',
  };
}
export class Store {
  private revisions = new WeakMap<Session, string>();
  constructor(readonly root = dataDirectory()) {}
  projectDir(cwd: string): string {
    return path.join(this.root, 'projects', sha256(cwd).slice(0, 24));
  }
  sessionPath(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new AxiomError('SESSION_ID', 'Invalid session id');
    return path.join(this.root, 'sessions', id + '.json');
  }
  async save(session: Session): Promise<void> {
    session.updatedAt = new Date().toISOString();
    const file = this.sessionPath(session.id);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const lock = await open(file + '.lock', 'wx', 0o600).catch(() => {
      throw new AxiomError(
        'SESSION_LOCKED',
        'Session is being saved; inspect any stale .lock after stopping the owner',
      );
    });
    try {
      const bytes = await readFile(file, 'utf8').catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return null;
        throw e;
      });
      const expected = this.revisions.get(session);
      if (expected !== undefined && (bytes === null || sha256(bytes) !== expected))
        throw new AxiomError(
          'SESSION_CONFLICT',
          'Session changed in another process; original preserved. Start a new session or reload.',
        );
      // Keep the last valid snapshot. Never replace a recovery copy with corrupt data.
      try {
        await writeJSON(file + '.bak', await this.load(session.id));
      } catch (e) {
        if (!(e instanceof AxiomError && e.code === 'SESSION_CORRUPT')) throw e;
      }
      const next = JSON.stringify(session, null, 2) + '\n';
      await atomicWrite(file, next);
      this.revisions.set(session, sha256(next));
    } finally {
      await lock.close();
      await unlink(file + '.lock').catch(() => {});
    }
  }

  async load(id: string): Promise<Session> {
    const file = this.sessionPath(id);
    let value: unknown;
    try {
      if ((await lstat(file)).size > 16 * 1024 * 1024) throw new Error('Oversized session');
      const bytes = await readFile(file, 'utf8');
      value = JSON.parse(bytes);
      let v = object(value);
      if (v.schema === undefined && typeof v.projectRoot === 'string' && Array.isArray(v.history)) {
        value = {
          ...v,
          schema: 1,
          cwd: v.projectRoot,
          model: v.model ?? '',
          backend: 'http://127.0.0.1:1234/v1',
          messages: v.history,
          status: 'migrated',
        };
        v = object(value);
      }
      if (
        v.schema !== 1 ||
        v.id !== id ||
        typeof v.cwd !== 'string' ||
        typeof v.model !== 'string' ||
        typeof v.backend !== 'string' ||
        !['fast', 'deep'].includes(String(v.mode)) ||
        !Array.isArray(v.messages) ||
        typeof v.createdAt !== 'string' ||
        typeof v.updatedAt !== 'string' ||
        typeof v.status !== 'string'
      )
        throw new Error('Invalid schema');
      for (const msg of v.messages) {
        const m = object(msg);
        if (
          !['system', 'user', 'assistant', 'tool'].includes(String(m.role)) ||
          (m.content !== null && typeof m.content !== 'string')
        )
          throw new Error('Invalid message');
      }
      this.revisions.set(value as Session, sha256(bytes));
      return value as Session;
    } catch (cause) {
      throw new AxiomError(
        'SESSION_CORRUPT',
        `Cannot load ${id}; original preserved. Recovery snapshot: ${file}.bak`,
        { cause },
      );
    }
  }
  async recover(id: string): Promise<void> {
    const file = this.sessionPath(id);
    const text = await readFile(file + '.bak', 'utf8');
    const v = object(JSON.parse(text));
    if (v.schema !== 1 || v.id !== id || !Array.isArray(v.messages))
      throw new AxiomError('SESSION_CORRUPT', 'Invalid recovery snapshot');
    await copyFile(file, file + '.corrupt').catch(() => {});
    await atomicWrite(file, text);
  }
  async sessions(cwd: string): Promise<{ id: string; updatedAt: string; status: string }[]> {
    const names = await readdir(path.join(this.root, 'sessions')).catch(() => [] as string[]);
    const result = [];
    for (const name of names.filter((n) => /^[a-f0-9-]{36}\.json$/.test(n))) {
      try {
        const s = await this.load(name.slice(0, -5));
        if (s.cwd === cwd) result.push({ id: s.id, updatedAt: s.updatedAt, status: s.status });
      } catch {
        /* corrupt files remain available for recovery */
      }
    }
    return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async audit(
    sessionId: string,
    event: { action: string; targetHash: string; outcome: string; correlationId: string },
  ): Promise<void> {
    const dir = path.join(this.root, 'audit', sessionId);
    await writeJSON(path.join(dir, `${Date.now()}-${randomUUID()}.json`), {
      ...event,
      at: new Date().toISOString(),
    });
  }
}

// Compatibility with 0.1 sessions and embedding API. Migration never deletes the old history.
export interface LegacySession {
  id: string;
  createdAt: string;
  updatedAt: string;
  projectRoot: string;
  model: string | null;
  mode: 'fast' | 'deep';
  history: Message[];
}
export function legacySession(
  projectRoot: string,
  model: string | null,
  mode: 'fast' | 'deep',
): LegacySession {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
    projectRoot,
    model,
    mode,
    history: [],
  };
}
export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw e;
  }
}
export const writeJson = writeJSON;
export function defaultSettings(env: NodeJS.ProcessEnv = process.env) {
  return {
    baseUrl: env.PILOTCODE_BASE_URL || 'http://127.0.0.1:1234/v1',
    model: null as string | null,
    mode: 'fast' as 'fast' | 'deep',
    autoUpdateCheck: false,
    lastUpdateCheck: null as string | null,
  };
}
export async function loadSettings(env: NodeJS.ProcessEnv = process.env) {
  return {
    ...defaultSettings(env),
    ...(await readJson(path.join(dataDirectory(env), 'settings.json'), {})),
    autoUpdateCheck: false,
  };
}
export async function saveSettings(
  settings: ReturnType<typeof defaultSettings>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await writeJSON(path.join(dataDirectory(env), 'settings.json'), settings);
}
export async function saveSession(
  session: LegacySession,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const store = new Store(dataDirectory(env));
  session.updatedAt = new Date().toISOString();
  await store.save({
    schema: 1,
    id: session.id,
    cwd: session.projectRoot,
    model: session.model ?? '',
    backend: env.PILOTCODE_BASE_URL || 'http://127.0.0.1:1234/v1',
    mode: session.mode,
    messages: session.history,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    status: 'idle',
  });
}
export async function getSessions(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LegacySession[]> {
  const store = new Store(dataDirectory(env));
  const summaries = await store.sessions(projectRoot);
  const result = [];
  for (const summary of summaries) {
    const s = await store.load(summary.id);
    result.push({
      id: s.id,
      projectRoot: s.cwd,
      model: s.model,
      mode: s.mode,
      history: s.messages,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    });
  }
  return result;
}
