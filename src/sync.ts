/* Optional CLI -> browser history snapshot: local-first, explicit opt-in, E2EE.
 * The relay sees only RSA-wrapped AES-GCM ciphertext and deletes it after ACK/TTL.
 */
import { randomBytes, webcrypto, createHash } from 'node:crypto';
import { readdir, lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Store, readJson, writeJSON } from './storage.js';
import { OSSecretStore, accountOrigin } from './auth.js';
import { redact } from './core.js';

export const DEFAULT_ACCOUNT_API = 'https://vkmmqhnuvphiyblyjgif.supabase.co/functions/v1/axiom-bridge';
const hash = (input: string): string => createHash('sha256').update(input).digest('hex');
const encoded = (bytes: ArrayBuffer | Uint8Array): string =>
  Buffer.from(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes).toString('base64url');
const limitText = (value: unknown, max: number) => typeof value === 'string' ? redact(value).slice(0, max) : '';

export interface SyncSnapshot {
  schema: 1;
  modules: { id: string; name: string; version: string; source: string }[];
  chats: {
    id: string; title: string; date: string; model: string;
    messages: { role: 'user' | 'assistant'; content: string }[];
  }[];
}

/* Read only Axiom state. Never walk or upload the user's project tree. */
export async function snapshotForBrowser(store: Store, modules: SyncSnapshot['modules'] = []): Promise<SyncSnapshot> {
  const dir = path.join(store.root, 'sessions');
  const names = await readdir(dir).catch(() => [] as string[]);
  const metadata: { file: string; modified: number }[] = [];
  for (const name of names) {
    if (!/^[0-9a-f-]{36}\.json$/i.test(name)) continue;
    const file = path.join(dir, name);
    try {
      const info = await lstat(file);
      if (info.isFile() && info.size <= 1024 * 1024)
        metadata.push({ file, modified: info.mtimeMs });
    } catch { /* interrupted or removed session */ }
  }
  metadata.sort((a, b) => b.modified - a.modified);
  const chats: SyncSnapshot['chats'] = [];
  let budget = 125000;
  for (const entry of metadata.slice(0, 12)) {
    if (budget < 1000) break;
    try {
      const session = JSON.parse(await readFile(entry.file, 'utf8')) as {
        id?: unknown; updatedAt?: unknown; model?: unknown;
        messages?: { role?: unknown; content?: unknown }[];
      };
      if (!Array.isArray(session.messages) || typeof session.id !== 'string') continue;
      const messages = session.messages
        .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .slice(-24).map(m => ({
          role: m.role as 'user' | 'assistant',
          content: limitText(m.content, 1000)
        })).filter(m => m.content);
      if (!messages.length) continue;
      const title = messages.find(m => m.role === 'user')?.content.slice(0, 100) || 'Saved conversation';
      const chat = {
        id: session.id, title, date: limitText(session.updatedAt, 40),
        model: limitText(session.model, 100), messages
      };
      const size = Buffer.byteLength(JSON.stringify(chat));
      if (size > budget) continue;
      budget -= size;
      chats.push(chat);
    } catch { /* malformed sessions are left intact and not uploaded */ }
  }
  return { schema: 1, modules: modules.slice(0, 60).map(m => ({
    id: limitText(m.id, 100),
    name: limitText(m.name, 100),
    version: limitText(m.version, 50),
    source: limitText(m.source, 90)
  })), chats };
}

export async function sealSnapshot(snapshot: SyncSnapshot, publicKey: JsonWebKey) {
  if (publicKey.kty !== 'RSA' || publicKey.alg !== 'RSA-OAEP-256' ||
      publicKey.e !== 'AQAB' || !publicKey.n)
    throw new Error('Unsupported profile encryption key');
  const key = await webcrypto.subtle.importKey('jwk', publicKey, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  const aes = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = randomBytes(12);
  const plaintext = Buffer.from(JSON.stringify(snapshot));
  if (plaintext.length > 170000) throw new Error('History snapshot exceeds the upload budget');
  const ciphertext = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, plaintext);
  const rawKey = await webcrypto.subtle.exportKey('raw', aes);
  const wrapped = await webcrypto.subtle.encrypt({ name: 'RSA-OAEP' }, key, rawKey);
  return { v: 1, alg: 'RSA-OAEP-256+A256GCM', ek: encoded(wrapped), iv: encoded(iv), data: encoded(ciphertext) };
}

/* Called once before a CLI session starts, only when opted in and linked. */
export async function uploadSnapshot(
  store: Store,
  endpoint: string,
  modules: SyncSnapshot['modules'],
  log: (message: string) => void = () => {},
  fetcher: typeof fetch = fetch,
): Promise<'uploaded' | 'unchanged' | 'skipped'> {
  const baseURL = accountOrigin(endpoint);
  const token = await new OSSecretStore(baseURL, store).get();
  if (!token) { log('History sync skipped: link the CLI with pilotcode login first.'); return 'skipped'; }
  const snapshot = await snapshotForBrowser(store, modules);
  const fingerprint = hash(JSON.stringify(snapshot));
  const metadataFile = path.join(store.root, 'account', 'sync-state.json');
  const previous = await readJson<{ fingerprint?: string; endpoint?: string }>(metadataFile, {});
  if (previous.fingerprint === fingerprint && previous.endpoint === baseURL) return 'unchanged';
  const request = async (route: string, method = 'GET', payload?: unknown) => {
    const response = await fetcher(baseURL + route, {
      method, redirect: 'error',
      headers: {
        Authorization: 'Bearer ' + token,
        ...(payload === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      signal: AbortSignal.timeout(10000)
    });
    const data: any = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error('Server HTTP ' + response.status + (data?.message ? ': ' + String(data.message).slice(0, 110) : ''));
    return data;
  };
  const { publicKey } = await request('/api/sync/key');
  if (!publicKey) {
    log('History sync skipped: open your website profile first to create its encryption key.');
    return 'skipped';
  }
  const envelope = await sealSnapshot(snapshot, publicKey);
  await request('/api/sync/upload', 'POST', { envelope });
  await writeJSON(metadataFile, { fingerprint, endpoint: baseURL, at: new Date().toISOString() });
  log('Encrypted profile snapshot queued for browser delivery (expires after 24 hours).');
  return 'uploaded';
}
