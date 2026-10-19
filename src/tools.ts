import { randomUUID } from 'node:crypto';
import {
  AxiomError,
  Permissions,
  object,
  string,
  integer,
  sha256,
  errorInfo,
  redact,
  type ToolDefinition,
} from './core.js';
import { Workspace, projectPath, inside, approvalForCommand } from './workspace.js';
import { Store, dataDirectory } from './storage.js';
import { runCommand } from './command.js';
export { projectPath, inside };
const text = { type: 'string' };
const num = { type: 'integer', minimum: 1 };
const define = (
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
): ToolDefinition => ({
  type: 'function',
  function: {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
  },
});
export const toolDefinitions: ToolDefinition[] = [
  define('list_files', 'List allowed project files, respecting ignore rules.', { path: text }),
  define(
    'read_file',
    'Read UTF-8 file; returns numbered lines and SHA256 for safe edits.',
    { path: text, start_line: num, end_line: num },
    ['path'],
  ),
  define(
    'search',
    'Bounded literal, case-insensitive lexical search in project text.',
    { query: text },
    ['query'],
  ),
  define(
    'edit_file',
    'Replace one exact, unique context. Provide SHA256 from read_file. Preserves CRLF. Approval required.',
    { path: text, old_text: text, new_text: text, expected_sha256: text },
    ['path', 'old_text', 'new_text', 'expected_sha256'],
  ),
  define(
    'create_file',
    'Create a new UTF-8 file; never replaces an existing file. Approval required.',
    { path: text, content: text },
    ['path', 'content'],
  ),
  define(
    'write_file',
    'Create/replace text. Existing file requires expected_sha256. Approval required.',
    { path: text, content: text, expected_sha256: text },
    ['path', 'content'],
  ),
  define(
    'run_command',
    'Execute an executable with an argument array. No implicit shell; explicit approval required. Commands are not sandboxed.',
    {
      program: text,
      args: { type: 'array', items: text, maxItems: 100 },
      timeout_ms: { type: 'integer', minimum: 1, maximum: 120000 },
    },
    ['program', 'args'],
  ),
  define('git_status', 'Read Git status.', {}),
  define('git_diff', 'Read Git diff for a permitted path (no external diff).', { path: text }, [
    'path',
  ]),
];
export class Tools {
  edits = 0;
  failures = 0;
  calls = 0;
  constructor(
    readonly workspace: Workspace,
    readonly signal: AbortSignal,
  ) {}
  async execute(name: string, raw: unknown): Promise<string> {
    this.signal.throwIfAborted();
    this.calls++;
    const args = object(raw);
    const id = randomUUID();
    try {
      const def = toolDefinitions.find((t) => t.function.name === name);
      if (!def) throw new AxiomError('UNKNOWN_TOOL', `Unknown tool ${name}`);
      const fields = object(def.function.parameters.properties);
      if (Object.keys(args).some((k) => !Object.hasOwn(fields, k)))
        throw new AxiomError('TOOL_INPUT', 'Unexpected argument');
      const result = await this.invoke(name, args);
      await this.workspace.store.audit(this.workspace.sessionId, {
        action: name,
        targetHash: sha256(JSON.stringify(args)),
        outcome: 'completed',
        correlationId: id,
      });
      return redact(result);
    } catch (error) {
      this.failures++;
      await this.workspace.store.audit(this.workspace.sessionId, {
        action: name,
        targetHash: sha256(JSON.stringify(args)),
        outcome: errorInfo(error).code,
        correlationId: id,
      });
      throw error;
    }
  }
  private async invoke(name: string, args: Record<string, unknown>): Promise<string> {
    const w = this.workspace;
    switch (name) {
      case 'list_files': {
        const prefix =
          args.path === undefined ? '' : string(args.path, 'path', 1000).replace(/\/$/, '');
        if (prefix && prefix !== '.') await w.resolve(prefix);
        return (await w.files())
          .filter((f) => !prefix || prefix === '.' || f.startsWith(prefix + '/'))
          .slice(0, 200)
          .join('\n');
      }
      case 'read_file': {
        const file = string(args.path, 'path', 1000),
          content = await w.read(file);
        const lines = content.split('\n');
        const start =
          args.start_line === undefined ? 1 : integer(args.start_line, 'start_line', 1, 1000000);
        const end =
          args.end_line === undefined
            ? Math.min(start + 199, lines.length)
            : integer(args.end_line, 'end_line', start, 1000000);
        return JSON.stringify({
          path: file,
          sha256: sha256(content),
          totalLines: lines.length,
          content: lines
            .slice(start - 1, end)
            .map((l, i) => `${start + i}: ${l}`)
            .join('\n')
            .slice(0, 20000),
        });
      }
      case 'search': {
        const query = string(args.query, 'query', 200).toLowerCase();
        if (!query) throw new AxiomError('TOOL_INPUT', 'Empty query');
        const lines: { file: string; line: number; text: string }[] = [];
        let bytes = 0;
        for (const file of await w.files(500)) {
          this.signal.throwIfAborted();
          let content;
          try {
            content = await w.read(file);
          } catch {
            continue;
          }
          bytes += Buffer.byteLength(content);
          if (bytes > 2_000_000) break;
          for (const [i, line] of content.split('\n').entries())
            lines.push({ file, line: i + 1, text: line });
        }
        let selected: typeof lines | undefined;
        try {
          // Only already validated text goes to stdin: rg cannot traverse paths or load .ripgreprc.
          const result = await runCommand(
            'rg',
            [
              '--no-config',
              '--fixed-strings',
              '--ignore-case',
              '--line-number',
              '--max-count',
              '50',
              '--color',
              'never',
              '--',
              query,
            ],
            w.root,
            { signal: this.signal, timeoutMs: 5000, input: lines.map((l) => l.text).join('\n') },
          );
          if (
            [0, 1].includes(result.exitCode ?? -1) &&
            !result.truncated &&
            !result.timedOut &&
            !result.cancelled
          ) {
            selected = result.stdout.split('\n').flatMap((line) => {
              const n = /^(\d+):/.exec(line);
              const match = n ? lines[Number(n[1]) - 1] : undefined;
              return match ? [match] : [];
            });
          }
        } catch {
          /* optional ripgrep unavailable: deterministic literal fallback */
        }
        this.signal.throwIfAborted();
        selected ??= lines.filter((l) => l.text.toLowerCase().includes(query)).slice(0, 50);
        return (
          selected.map((l) => `${l.file}:${l.line}: ${l.text.slice(0, 300)}`).join('\n') ||
          'No matches within scan limits'
        );
      }
      case 'edit_file': {
        const file = string(args.path, 'path', 1000),
          before = await w.read(file);
        const old = string(args.old_text, 'old_text'),
          replacement = string(args.new_text, 'new_text');
        const eol = before.includes('\r\n') ? '\r\n' : '\n';
        const norm = (s: string) => s.replace(/\r\n|\n/g, eol);
        const needle = norm(old);
        if (
          !needle ||
          !before.includes(needle) ||
          before.indexOf(needle) !== before.lastIndexOf(needle)
        )
          throw new AxiomError('EDIT_CONTEXT', 'Expected context must match exactly once');
        const result = await w.write(
          file,
          before.replace(needle, () => norm(replacement)),
          string(args.expected_sha256, 'expected_sha256', 64),
        );
        this.edits++;
        return result;
      }
      case 'create_file':
      case 'write_file': {
        const file = string(args.path, 'path', 1000);
        const expected =
          args.expected_sha256 === undefined
            ? undefined
            : string(args.expected_sha256, 'expected_sha256', 64);
        if (name === 'write_file' && expected === undefined) {
          try {
            await w.read(file);
            throw new AxiomError(
              'EDIT_CONTEXT',
              'Existing file requires expected_sha256 from read_file',
            );
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
          }
        }
        const result = await w.write(
          file,
          string(args.content, 'content', 300000),
          expected,
          name === 'create_file',
        );
        this.edits++;
        return result;
      }
      case 'run_command': {
        const program = string(args.program, 'program', 1000);
        if (!Array.isArray(args.args) || args.args.length > 100)
          throw new AxiomError('TOOL_INPUT', 'Expected args array');
        const argv = args.args.map((v) => string(v, 'argument', 8000));
        await w.permissions.require(approvalForCommand(w.root, program, argv));
        this.signal.throwIfAborted();
        const result = await runCommand(program, argv, w.root, {
          signal: this.signal,
          timeoutMs:
            args.timeout_ms === undefined
              ? 30000
              : integer(args.timeout_ms, 'timeout_ms', 1, 120000),
        });
        if (result.exitCode !== 0 || result.timedOut || result.cancelled)
          throw new AxiomError('COMMAND_FAILED', JSON.stringify(result));
        return JSON.stringify(result);
      }
      case 'git_status':
        return JSON.stringify(
          await runCommand(
            'git',
            ['-c', 'core.fsmonitor=false', 'status', '--short', '--untracked-files=no'],
            w.root,
            { signal: this.signal },
          ),
        );
      case 'git_diff': {
        const file = string(args.path, 'path', 1000);
        await w.resolve(file);
        return JSON.stringify(
          await runCommand(
            'git',
            ['-c', 'core.fsmonitor=false', 'diff', '--no-ext-diff', '--no-textconv', '--', file],
            w.root,
            { signal: this.signal },
          ),
        );
      }
      default:
        throw new AxiomError('UNKNOWN_TOOL', name);
    }
  }
}
// Original embedding API: preserve explicit deny and write/read behavior, never silently execute legacy shell text.
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  context: {
    root: string;
    ask: (question: string) => Promise<boolean>;
    onEvent?: (text: string) => void;
    env?: NodeJS.ProcessEnv;
  },
): Promise<string> {
  const permissions = new Permissions(async (req) =>
    (await context.ask(`${req.detail}\nWorking directory: ${req.cwd}\nApprove? [y/N] `))
      ? 'once'
      : 'deny',
  );
  const w = new Workspace(
    context.root,
    permissions,
    new Store(dataDirectory(context.env)),
    randomUUID(),
    context.onEvent,
  );
  try {
    if (name === 'read_file' && args.start_line === undefined && args.end_line === undefined)
      return await w.read(string(args.path, 'path'));
    if (name === 'write_file')
      return await w.write(string(args.path, 'path'), string(args.content, 'content', 300000));
    if (name === 'run_command' && typeof args.command === 'string') {
      await permissions.require({
        kind: 'command',
        target: args.command,
        detail: args.command,
        cwd: context.root,
      });
      throw new AxiomError('SHELL_REQUIRED', 'Legacy shell text is disabled; use program and args');
    }
    return await new Tools(w, new AbortController().signal).execute(name, args);
  } catch (e) {
    if (e instanceof AxiomError && e.code === 'PERMISSION_DENIED')
      return 'Denied by user. No changes made.';
    throw e;
  }
}
