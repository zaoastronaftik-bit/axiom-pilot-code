import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';

export function dataDirectory(env = process.env) {
  if (env.PILOTCODE_HOME) return env.PILOTCODE_HOME;
  if (process.platform === 'win32') return join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'AxiomPilotCode');
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'axiom-pilot-code');
}

export async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`Cannot read ${path}: ${error.message}`, { cause: error });
  }
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

export function defaultSettings(env = process.env) {
  return {
    baseUrl: env.PILOTCODE_BASE_URL || 'http://127.0.0.1:1234/v1',
    model: null,
    mode: 'fast',
    autoUpdateCheck: true,
    lastUpdateCheck: null,
  };
}

export async function loadSettings(env = process.env) {
  return { ...defaultSettings(env), ...await readJson(join(dataDirectory(env), 'settings.json'), {}) };
}

export async function saveSettings(settings, env = process.env) {
  await writeJson(join(dataDirectory(env), 'settings.json'), settings);
}

export function newSession(projectRoot, model, mode) {
  const now = new Date().toISOString();
  return { id: randomUUID(), createdAt: now, updatedAt: now, projectRoot, model, mode, history: [] };
}

export async function saveSession(session, env = process.env) {
  session.updatedAt = new Date().toISOString();
  await writeJson(join(dataDirectory(env), 'sessions', `${session.id}.json`), session);
}

export async function getSessions(projectRoot, env = process.env) {
  const folder = join(dataDirectory(env), 'sessions');
  let entries;
  try { entries = await readdir(folder); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const sessions = await Promise.all(entries.filter(f => /^[a-f\d-]{36}\.json$/i.test(f)).map(async f => {
    try { return await readJson(join(folder, f), null); }
    catch { return null; }
  }));
  return sessions.filter(s => s && s.projectRoot === projectRoot && Array.isArray(s.history))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
