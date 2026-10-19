import { constants } from 'node:fs';
import { lstat, realpath, readdir, open, mkdir, rename, unlink, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import ignore, { type Ignore } from 'ignore';
import { AxiomError, Permissions, sha256, type Approval } from './core.js';
import { Store, writeJSON } from './storage.js';
import { runCommand } from './command.js';

export const MAX_FILE = 300000;
export function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep));
}
export function protectedPath(relative: string): boolean {
  return relative
    .replace(/\\/g, '/')
    .split('/')
    .some(
      (part) =>
        /^(?:\.git|node_modules|\.ssh|\.aws|\.azure|\.gnupg|\.axiom|\.venv|venv|__pycache__|\.npmrc|\.pypirc|credentials(?:\.json)?|id_(?:rsa|ed25519|ecdsa)|.*\.(?:pem|key|p12|pfx|keystore)|\.env(?:\..*)?)$/i.test(
          part,
        ) || /(?:^|[._-])(?:tokens?|secrets?)(?:[._-]|$)/i.test(part),
    );
}
export async function projectPath(
  root: string,
  input: string,
  { writing = false } = {},
): Promise<string> {
  if (
    typeof input !== 'string' ||
    !input ||
    /[\0\x01-\x1f:]/.test(input) ||
    path.isAbsolute(input) ||
    /^[\\/]/.test(input)
  )
    throw new AxiomError('PATH', 'Use a valid relative project path');
  const parts = input.replace(/\\/g, '/').split('/');
  if (parts.some((p) => p === '..'))
    throw new AxiomError('PATH_ESCAPE', 'Path escapes project root');
  if (
    parts.some((p) => /[. ]$/.test(p) && p !== '.') ||
    parts.some((p) => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))
  )
    throw new AxiomError('PATH', 'Ambiguous Windows path');
  if (protectedPath(input))
    throw new AxiomError('PROTECTED', 'Access to protected paths is disabled');
  const rootReal = await realpath(root);
  const canonical = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);
  if (canonical(rootReal) !== canonical(path.resolve(root)))
    throw new AxiomError('ROOT_CHANGED', 'Project root is no longer its original canonical path');
  const target = path.resolve(rootReal, ...parts);
  if (!inside(rootReal, target)) throw new AxiomError('PATH_ESCAPE', 'Path escapes project root');
  let current = rootReal;
  for (const part of path.relative(rootReal, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const s = await lstat(current);
      if (s.isSymbolicLink())
        throw new AxiomError('SYMLINK', 'Symbolic link may escape project; links are disabled');
      if (!inside(rootReal, await realpath(current)))
        throw new AxiomError('PATH_ESCAPE', 'Resolved path escapes project');
    } catch (e) {
      if (writing && (e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw e;
    }
  }
  return target;
}
export async function readText(file: string, max = MAX_FILE): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const s = await handle.stat();
    const current = await lstat(file);
    if (current.isSymbolicLink() || current.ino !== s.ino || current.dev !== s.dev)
      throw new AxiomError('CONFLICT', 'File changed before opening');
    if (!s.isFile() || s.nlink > 1)
      throw new AxiomError('FILE_TYPE', 'Only regular, non-hardlinked files are supported');
    if (s.size > max) throw new AxiomError('FILE_SIZE', `File exceeds ${max} bytes`);
    const bytes = Buffer.alloc(max + 1);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const next = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
      if (!next.bytesRead) break;
      bytesRead += next.bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== s.size || after.mtimeMs !== s.mtimeMs)
      throw new AxiomError('CONFLICT', 'File changed while reading');
    if (bytesRead > max || bytes.subarray(0, bytesRead).includes(0))
      throw new AxiomError('FILE_ENCODING', 'Binary or oversized file');
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        bytes.subarray(0, bytesRead),
      );
    } catch {
      throw new AxiomError('FILE_ENCODING', 'File is not valid UTF-8');
    }
  } finally {
    await handle.close();
  }
}
export function previewDiff(name: string, before: string | null, after: string): string {
  const old = (before ?? '').split('\n'),
    next = after.split('\n');
  let start = 0;
  while (start < old.length && start < next.length && old[start] === next[start]) start++;
  let endOld = old.length,
    endNext = next.length;
  while (endOld > start && endNext > start && old[endOld - 1] === next[endNext - 1]) {
    endOld--;
    endNext--;
  }
  const lines = [
    `--- ${before === null ? '/dev/null' : name}`,
    `+++ ${name}`,
    `@@ -${start + 1},${endOld - start} +${start + 1},${endNext - start} @@`,
    ...old.slice(start, endOld).map((l) => '-' + l),
    ...next.slice(start, endNext).map((l) => '+' + l),
  ];
  return lines.join('\n');
}
interface Change {
  schema: 1;
  id: string;
  cwd: string;
  file: string;
  before: string | null;
  afterHash: string;
  mode: number;
  state: 'prepared' | 'applied' | 'undone';
}
export class Workspace {
  constructor(
    readonly root: string,
    readonly permissions: Permissions,
    readonly store: Store,
    readonly sessionId: string,
    readonly onRead: (file: string) => void = () => {},
    readonly signal?: AbortSignal,
  ) {}
  async read(file: string): Promise<string> {
    this.signal?.throwIfAborted();
    const text = await readText(await projectPath(this.root, file));
    this.signal?.throwIfAborted();
    this.onRead(file);
    return text;
  }
  private async existing(file: string): Promise<string | null> {
    try {
      return await this.read(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }
  async write(file: string, after: string, expected?: string, createOnly = false): Promise<string> {
    if (Buffer.byteLength(after) > MAX_FILE || after.includes('\0'))
      throw new AxiomError('FILE_SIZE', 'Text must be at most 300 KB with no NUL');
    this.signal?.throwIfAborted();
    const target = await projectPath(this.root, file, { writing: true });
    if (target === this.root) throw new AxiomError('PATH', 'Cannot replace project root');
    const before = await this.existing(file);
    if (createOnly && before !== null)
      throw new AxiomError('FILE_EXISTS', 'create_file cannot replace an existing file');
    if (expected !== undefined && (before === null || sha256(before) !== expected))
      throw new AxiomError('CONFLICT', 'File changed since read; read it again');
    if (before === after) return 'No change';
    const detail = previewDiff(file, before, after);
    await this.permissions.require({ kind: 'write', target: file, cwd: this.root, detail });
    this.signal?.throwIfAborted();
    await projectPath(this.root, file, { writing: true });
    if ((await this.existing(file)) !== before)
      throw new AxiomError('CONFLICT', 'File changed while awaiting approval; no changes made');
    const mode = before === null ? 0o644 : (await lstat(target)).mode & 0o777;
    const change: Change = {
      schema: 1,
      id: randomUUID(),
      cwd: this.root,
      file,
      before,
      afterHash: sha256(after),
      mode,
      state: 'prepared',
    };
    const journal = path.join(this.store.root, 'backups', this.sessionId, change.id + '.json');
    await writeJSON(journal, change);
    await this.replace(file, before, after, mode);
    change.state = 'applied';
    await writeJSON(journal, change);
    return `Successfully ${before === null ? 'created' : 'updated'} ${file}. sha256=${change.afterHash}`;
  }
  private async replace(
    file: string,
    before: string | null,
    after: string,
    mode: number,
  ): Promise<void> {
    this.signal?.throwIfAborted();
    const target = await projectPath(this.root, file, { writing: true });
    // Create each missing directory with a path check on both sides; never follow links intentionally.
    const parts = path.relative(this.root, path.dirname(target)).split(path.sep).filter(Boolean);
    let relative = '';
    for (const part of parts) {
      relative = relative ? relative + '/' + part : part;
      const dir = await projectPath(this.root, relative, { writing: true });
      await mkdir(dir).catch((e) => {
        if (e.code !== 'EEXIST') throw e;
      });
      await projectPath(this.root, relative);
    }
    const temp = path.join(path.dirname(target), `.axiom-${randomUUID()}.tmp`);
    const handle = await open(temp, 'wx', mode);
    try {
      await handle.writeFile(after, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await projectPath(this.root, file, { writing: true });
      if ((await this.existing(file)) !== before)
        throw new AxiomError('CONFLICT', 'Concurrent edit detected; replacement cancelled');
      this.signal?.throwIfAborted();
      await rename(temp, target);
    } finally {
      await unlink(temp).catch(() => {});
    }
  }
  async undo(): Promise<string> {
    this.signal?.throwIfAborted();
    const dir = path.join(this.store.root, 'backups', this.sessionId);
    const entries = await readdir(dir).catch(() => [] as string[]);
    const changes: { file: string; change: Change; time: number }[] = [];
    for (const file of entries) {
      const full = path.join(dir, file);
      const change = JSON.parse(await readFile(full, 'utf8')) as Change;
      if (change.cwd === this.root && change.state === 'applied')
        changes.push({ file: full, change, time: (await lstat(full)).mtimeMs });
    }
    const latest = changes.sort((a, b) => b.time - a.time)[0];
    if (!latest) return 'No applied agent edits to undo';
    const { change } = latest;
    const current = await this.existing(change.file);
    if (current === null || sha256(current) !== change.afterHash)
      throw new AxiomError('CONFLICT', 'Undo refused: file contains later changes');
    await this.permissions.require({
      kind: 'write',
      target: change.file,
      cwd: this.root,
      detail: previewDiff(change.file, current, change.before ?? ''),
    });
    const target = await projectPath(this.root, change.file);
    this.signal?.throwIfAborted();
    if ((await this.existing(change.file)) !== current)
      throw new AxiomError('CONFLICT', 'File changed while approving undo');
    if (change.before === null) await unlink(target);
    else await this.replace(change.file, current, change.before, change.mode);
    change.state = 'undone';
    await writeJSON(latest.file, change);
    return `Undone ${change.file}`;
  }
  async files(limit = 2000): Promise<string[]> {
    this.signal?.throwIfAborted();
    // git handles nested ignore rules, tracked files and negations exactly when available.
    try {
      const git = await runCommand(
        'git',
        [
          '-c',
          'core.fsmonitor=false',
          'ls-files',
          '--cached',
          '--others',
          '--exclude-standard',
          '-z',
        ],
        this.root,
        { maxOutput: 2_000_000, timeoutMs: 5000 },
      );
      if (git.exitCode === 0 && !git.truncated) {
        const files = [...new Set(git.stdout.split('\0').filter(Boolean))]
          .filter((f) => !protectedPath(f))
          .sort();
        const result = [];
        for (const file of files.slice(0, limit)) {
          try {
            await projectPath(this.root, file);
            result.push(file);
          } catch {
            /* omit symlinks */
          }
        }
        return result;
      }
    } catch {
      /* non-git project: nested .gitignore fallback */
    }
    const result: string[] = [];
    let scanned = 0;
    const walk = async (
      dir: string,
      matchers: { base: string; rules: Ignore }[],
    ): Promise<void> => {
      if (result.length >= limit || scanned >= limit * 4) return;
      let local = matchers;
      try {
        const text = await this.read(dir ? dir + '/.gitignore' : '.gitignore');
        local = [...matchers, { base: dir, rules: ignore().add(text) }];
      } catch {
        /* absent/unreadable ignore */
      }
      const entries = (
        await readdir(await projectPath(this.root, dir || '.'), { withFileTypes: true })
      ).sort((a, b) => a.name.localeCompare(b.name, 'en'));
      for (const entry of entries) {
        this.signal?.throwIfAborted();
        if (++scanned > limit * 4 || result.length >= limit) break;
        const rel = dir ? dir + '/' + entry.name : entry.name;
        if (protectedPath(rel) || entry.isSymbolicLink()) continue;
        if (
          local.some((m) =>
            m.rules.ignores(
              (m.base ? rel.slice(m.base.length + 1) : rel) + (entry.isDirectory() ? '/' : ''),
            ),
          )
        )
          continue;
        if (entry.isDirectory()) await walk(rel, local);
        else if (entry.isFile()) result.push(rel);
      }
    };
    await walk('', []);
    return result;
  }
}
export async function discoverRoot(cwd: string): Promise<string> {
  const root = await realpath(cwd);
  try {
    const result = await runCommand(
      'git',
      ['-c', 'core.fsmonitor=false', 'rev-parse', '--show-toplevel'],
      root,
      { timeoutMs: 3000 },
    );
    if (result.exitCode === 0) return await realpath(result.stdout.trim());
  } catch {
    /* no git */
  }
  return root;
}
export const approvalForCommand = (root: string, program: string, args: string[]): Approval => ({
  kind: 'command',
  target: JSON.stringify([program, ...args]),
  cwd: root,
  detail: `Executable + argv (no implicit shell): ${JSON.stringify([program, ...args])}\nCommands can affect files outside this project and use the network.`,
});
