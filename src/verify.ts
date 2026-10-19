import type { Workspace } from './workspace.js';
import { approvalForCommand } from './workspace.js';
import { npmCommand, runCommand, type CommandResult } from './command.js';
import { object } from './core.js';
import path from 'node:path';
export interface Check {
  name: string;
  program: string;
  args: string[];
}
export interface Diagnostic {
  path: string;
  line: number;
  column: number | null;
  type: string;
  message: string;
}
export function diagnostics(output: string): Diagnostic[] {
  const result: Diagnostic[] = [];
  const seen = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const m =
      /^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s*(.*)$/.exec(line) ??
      /^(.+?):(\d+)(?::(\d+))?:\s*(error|warning|E\w*)?\s*(.*)$/.exec(line);
    if (!m) continue;
    const item = {
      path: m[1]!,
      line: Number(m[2]),
      column: m[3] ? Number(m[3]) : null,
      type: m[4] || 'error',
      message: m[5]!.slice(0, 500),
    };
    const key = JSON.stringify(item);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
    if (result.length >= 30) break;
  }
  return result;
}
export async function discoverChecks(workspace: Workspace): Promise<Check[]> {
  const files = await workspace.files();
  const checks: Check[] = [];
  if (files.includes('package.json')) {
    const pkg = object(JSON.parse(await workspace.read('package.json')));
    const scripts = pkg.scripts ? object(pkg.scripts) : {};
    for (const name of ['check', 'lint', 'test', 'build'])
      if (typeof scripts[name] === 'string')
        checks.push({ name: `npm ${name}`, ...(await npmCommand(['run', name])) });
  }
  if (
    files.includes('tsconfig.json') &&
    !checks.some((c) => c.name === 'npm check' || c.name === 'npm build')
  )
    checks.push({
      name: 'TypeScript (project compiler)',
      program: process.execPath,
      args: [
        path.join(workspace.root, 'node_modules', 'typescript', 'bin', 'tsc'),
        '--noEmit',
        '-p',
        'tsconfig.json',
      ],
    });
  if (files.includes('pyproject.toml') || files.includes('pytest.ini'))
    checks.push({
      name: 'pytest',
      program: process.platform === 'win32' ? 'python' : 'python3',
      args: ['-m', 'pytest', '-q'],
    });
  else if (files.some((f) => /(?:^|\/)test_[^/]+\.py$/.test(f)))
    checks.push({
      name: 'Python unittest',
      program: process.platform === 'win32' ? 'python' : 'python3',
      args: ['-m', 'unittest', 'discover'],
    });
  if (files.includes('Cargo.toml'))
    checks.push({ name: 'cargo test', program: 'cargo', args: ['test', '--offline'] });
  if (files.includes('go.mod'))
    checks.push({ name: 'go test', program: 'go', args: ['test', './...'] });
  if (files.some((f) => /\.(?:csproj|sln)$/.test(f)))
    checks.push({ name: 'dotnet test', program: 'dotnet', args: ['test', '--no-restore'] });
  return checks;
}
export interface Verification {
  status: 'passed' | 'failed' | 'not-run';
  results: {
    check: Check;
    result: CommandResult | null;
    diagnostics: Diagnostic[];
    error?: string;
  }[];
}
export async function verify(
  workspace: Workspace,
  signal: AbortSignal,
  selected?: Check[],
): Promise<Verification> {
  const checks = selected ?? (await discoverChecks(workspace));
  const results: Verification['results'] = [];
  for (const check of checks) {
    signal.throwIfAborted();
    try {
      await workspace.permissions.require(
        approvalForCommand(workspace.root, check.program, check.args),
      );
      signal.throwIfAborted();
      const result = await runCommand(check.program, check.args, workspace.root, {
        signal,
        timeoutMs: 60000,
      });
      results.push({
        check,
        result,
        diagnostics: diagnostics(result.stdout + '\n' + result.stderr),
      });
    } catch (e) {
      results.push({
        check,
        result: null,
        diagnostics: [],
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return {
    status:
      !results.length || results.every((r) => r.result === null)
        ? 'not-run'
        : results.every(
              (r) => r.result?.exitCode === 0 && !r.result.cancelled && !r.result.timedOut,
            )
          ? 'passed'
          : 'failed',
    results,
  };
}
