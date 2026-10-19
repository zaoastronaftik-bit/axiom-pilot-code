import { spawn, type ChildProcess } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { AxiomError, redact } from './core.js';

export interface CommandResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
  elapsedMs: number;
}
export function minimalEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'Path',
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'TEMP',
    'TMP',
    'TMPDIR',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'LANG',
    'LC_ALL',
  ])
    if (process.env[key]) env[key] = process.env[key];
  return env;
}
export async function terminateTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn(
        path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/pid', String(child.pid), '/T', '/F'],
        { shell: false, windowsHide: true, stdio: 'ignore' },
      );
      killer.once('error', () => {
        child.kill();
        resolve();
      });
      killer.once('close', () => resolve());
    });
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* already exited */
    }
  }
}
export async function runCommand(
  program: string,
  args: string[],
  cwd: string,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    maxOutput?: number;
    env?: NodeJS.ProcessEnv;
    input?: string;
  } = {},
): Promise<CommandResult> {
  if (
    !program ||
    /[\0\r\n]/.test(program) ||
    args.some((a) => typeof a !== 'string' || a.includes('\0'))
  )
    throw new AxiomError('COMMAND_INPUT', 'Invalid executable or arguments');
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(program))
    throw new AxiomError(
      'SHELL_REQUIRED',
      'Batch files require an explicit shell executable and arguments; they are never silently wrapped',
    );
  options.signal?.throwIfAborted();
  const start = performance.now();
  const limit = options.maxOutput ?? 32768;
  return await new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: options.env ?? minimalEnv(),
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '',
      bytes = 0,
      timedOut = false,
      cancelled = false,
      truncated = false,
      stop: Promise<void> | undefined;
    const stopTree = (): void => {
      stop ??= terminateTree(child);
    };
    const capture = (chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
      const remaining = Math.max(0, limit - bytes);
      bytes += chunk.length;
      if (bytes > limit) truncated = true;
      if (stream === 'stdout') stdout += chunk.subarray(0, remaining).toString('utf8');
      else stderr += chunk.subarray(0, remaining).toString('utf8');
    };
    if (child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(options.input);
    }
    child.stdout!.on('data', (d: Buffer) => capture(d, 'stdout'));
    child.stderr!.on('data', (d: Buffer) => capture(d, 'stderr'));
    const timeout = setTimeout(() => {
      timedOut = true;
      stopTree();
    }, options.timeoutMs ?? 30000);
    const abort = (): void => {
      cancelled = true;
      stopTree();
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    const cleanup = (): void => {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
    };
    child.once('error', (error) => {
      cleanup();
      reject(new AxiomError('COMMAND_START', `Cannot launch ${program}: ${error.message}`));
    });
    child.once('close', (exitCode, signal) => {
      cleanup();
      void (async () => {
        if (stop) await stop;
        resolve({
          exitCode,
          signal,
          stdout: redact(stdout),
          stderr: redact(stderr),
          timedOut,
          cancelled,
          truncated,
          elapsedMs: performance.now() - start,
        });
      })();
    });
  });
}
export async function npmCommand(args: string[]): Promise<{ program: string; args: string[] }> {
  if (process.platform !== 'win32') return { program: 'npm', args };
  const candidates = [
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.join(process.env.APPDATA || '', 'npm/node_modules/npm/bin/npm-cli.js'),
  ];
  for (const file of candidates) {
    try {
      await access(file);
      return { program: process.execPath, args: [file, ...args] };
    } catch {
      /* next */
    }
  }
  throw new AxiomError(
    'NPM_NOT_FOUND',
    'Cannot locate npm-cli.js beside Node. Install standard Node 22+ or use an explicit node/npm-cli.js command',
  );
}
