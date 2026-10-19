import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { dataDirectory } from './storage.js';

const MAX_READ = 80_000;
const MAX_WRITE = 300_000;
const MAX_COMMAND_OUTPUT = 10_000;
const PROTECTED = new Set(['.git', 'node_modules', '.env', '.env.local', '.env.production']);

export const toolDefinitions = [
  { type: 'function', function: { name: 'list_files', description: 'List files and folders in the current project directory, not recursively.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Relative folder path, defaults to .' } }, additionalProperties: false } } },
  { type: 'function', function: { name: 'read_file', description: 'Read a UTF-8 text file inside the project.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } } },
  { type: 'function', function: { name: 'write_file', description: 'Create or replace a text file inside the project. This ALWAYS requires user approval.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false } } },
  { type: 'function', function: { name: 'run_command', description: 'Run a shell command from the project folder. ALWAYS requires explicit user approval.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false } } },
];

export function inside(root, target) {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export async function projectPath(root, userPath, { writing = false } = {}) {
  if (typeof userPath !== 'string' || !userPath.trim() || userPath.includes('\0')) throw new Error('Invalid path.');
  if (isAbsolute(userPath) || /^[A-Za-z]:[\\/]/.test(userPath) || userPath.startsWith('\\\\')) throw new Error('Use a relative project path.');
  const parts = userPath.replace(/\\/g, '/').split('/');
  if (parts.some(p => PROTECTED.has(p.toLowerCase()))) throw new Error('Access to protected paths is disabled.');
  const rootReal = await realpath(root);
  const target = resolve(rootReal, userPath);
  if (!inside(rootReal, target)) throw new Error('Path escapes the project root.');

  // Resolve symlinks in existing parent directories, including for a new file.
  let ancestor = writing ? dirname(target) : target;
  for (;;) {
    try {
      const resolved = await realpath(ancestor);
      if (!inside(rootReal, resolved)) throw new Error('A symbolic link escapes the project root.');
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(ancestor);
      if (ancestor === parent) throw new Error('Cannot resolve parent directory.');
      ancestor = parent;
    }
  }
  if (writing) {
    try { const existing = await realpath(target); if (!inside(rootReal, existing)) throw new Error('File symlink escapes the project root.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return target;
}

async function approved(ask, description) {
  return await ask(`${description}\nApprove? [y/N] `);
}

function capped(value, limit = MAX_COMMAND_OUTPUT) {
  const text = String(value);
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[output truncated]`;
}

export async function executeTool(name, args, { root, ask, onEvent = () => {}, env = process.env }) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid tool parameters.');
  switch (name) {
    case 'list_files': {
      const target = await projectPath(root, args.path || '.');
      const entries = (await readdir(target, { withFileTypes: true }))
        .filter(e => !PROTECTED.has(e.name.toLowerCase()))
        .slice(0, 150)
        .map(e => `${e.isDirectory() ? '[dir] ' : '[file]'} ${e.name}`);
      return entries.join('\n') || '(empty folder)';
    }
    case 'read_file': {
      const path = await projectPath(root, args.path);
      const s = await stat(path);
      if (!s.isFile()) throw new Error('Not a regular file.');
      if (s.size > MAX_READ) throw new Error('File exceeds read limit (80 KB).');
      onEvent(`Reading ${args.path}`);
      return await readFile(path, 'utf8');
    }
    case 'write_file': {
      if (typeof args.content !== 'string' || Buffer.byteLength(args.content, 'utf8') > MAX_WRITE) throw new Error('Content must be UTF-8 text up to 300 KB.');
      const path = await projectPath(root, args.path, { writing: true });
      const rel = relative(await realpath(root), path);
      if (rel === '') throw new Error('Cannot write to root directory.');
      let exists = false;
      try { const s = await stat(path); if (!s.isFile()) throw new Error('Not a regular file.'); exists = true; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const size = Buffer.byteLength(args.content, 'utf8');
      const ok = await approved(ask, `${exists ? 'Replace' : 'Create'} ${rel} (${size} bytes)`);
      if (!ok) return 'Denied by user. No changes made.';
      await mkdir(dirname(path), { recursive: true });
      // Backups live outside project so an update won't overwrite them.
      if (exists) {
        const backup = join(dataDirectory(env), 'backups', `${randomUUID()}-${basename(path)}`);
        await mkdir(dirname(backup), { recursive: true });
        await copyFile(path, backup);
        onEvent(`Backup saved: ${backup}`);
      }
      const temp = `${path}.${randomUUID()}.tmp`;
      try { await writeFile(temp, args.content, 'utf8'); await rename(temp, path); }
      finally { await rm(temp, { force: true }).catch(() => {}); }
      onEvent(`${exists ? 'Updated' : 'Created'} ${rel}`);
      return `Successfully ${exists ? 'updated' : 'created'} ${rel}.`;
    }
    case 'run_command': {
      if (typeof args.command !== 'string' || !args.command.trim() || args.command.length > 1500) throw new Error('Invalid command.');
      const ok = await approved(ask, `Run in ${root}: ${args.command}`);
      if (!ok) return 'Denied by user. Command was not executed.';
      onEvent(`Running: ${args.command}`);
      return await new Promise(resolvePromise => {
        let combined = '';
        const child = spawn(args.command, { cwd: root, shell: true, windowsHide: true, env });
        const timeout = setTimeout(() => child.kill(), 30_000);
        child.stdout.on('data', d => { if (combined.length < MAX_COMMAND_OUTPUT) combined += d.toString(); });
        child.stderr.on('data', d => { if (combined.length < MAX_COMMAND_OUTPUT) combined += d.toString(); });
        child.on('error', e => { clearTimeout(timeout); resolvePromise(`Failed: ${e.message}`); });
        child.on('close', (code, signal) => { clearTimeout(timeout); resolvePromise(capped(`Exit: ${code ?? signal}\n${combined}`)); });
      });
    }
    default: throw new Error(`Unknown tool ${name}`);
  }
}
