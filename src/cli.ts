#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createInterface, type Interface } from 'node:readline/promises';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AxiomError,
  Permissions,
  safeText,
  errorInfo,
  type Backend,
  type Approval,
} from './core.js';
import { Store, newSession, loadSettings, saveSettings, readJson, writeJSON } from './storage.js';
import { OpenAIBackend, LMStudioClient, isLoopback } from './backend.js';
import { RuntimeManager, NativeRuntime, runtimeCatalog } from './runtime.js';
import { ModelManager } from './models.js';
import { Workspace, discoverRoot } from './workspace.js';
import { runAgent } from './agent.js';
import { compact } from './context.js';
import { detectHardware } from './hardware.js';
import { verify, discoverChecks } from './verify.js';
import { installedVersion, latestVersion, updatePackage } from './updater.js';
import { calibrate } from './autotune.js';
import { DeviceAuth, OSSecretStore, accountOrigin, openBrowser } from './auth.js';

const HELP = `AxiomPilotCode — local coding agent (V1 candidate; see docs/READINESS.md)
Usage:
  pilotcode [--cwd PATH | --project PATH] [--backend external|native] [--model ID]
  pilotcode run "task" [--verify] [--mode fast|deep] [--json]
  pilotcode doctor
  pilotcode runtime install|status|verify|cleanup|remove
  pilotcode models search [query] | download ID | list | verify ID | remove ID
  pilotcode models import FILE ID --license SPDX --source URL
  pilotcode verify | autotune | update [install] | login | logout | whoami

Options: --url URL --ctx 4096 --gpu-layers N --cpu --time-ms 300000 --max-steps 12
         --allow-write relative/path (repeat) --allow-command '["program","arg"]' (repeat)
         --approve-download exact-id --api-url https://account-api --local-only
         --structured-tools (explicit JSON tool protocol for models without native tools)
         --help --version
Approvals default to deny without a TTY. Command grants match the exact executable/argv.
No background services, cloud fallback, automatic update checks or required account.
REPL: /help /model /models /mode /status /resume /sessions /new /compact /clear /config
      /doctor /update /permissions /undo /diff /plan /verify /login /logout /whoami /exit`;
function numberOption(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw new AxiomError('ARGUMENT', `Expected integer ${min}..${max}`);
  return n;
}
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { values: v, positionals: p } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      cwd: { type: 'string' },
      project: { type: 'string' },
      backend: { type: 'string' },
      model: { type: 'string' },
      url: { type: 'string' },
      mode: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      verify: { type: 'boolean' },
      ctx: { type: 'string' },
      'gpu-layers': { type: 'string' },
      cpu: { type: 'boolean' },
      'time-ms': { type: 'string' },
      'max-steps': { type: 'string' },
      'allow-write': { type: 'string', multiple: true },
      'allow-command': { type: 'string', multiple: true },
      'approve-download': { type: 'string' },
      license: { type: 'string' },
      source: { type: 'string' },
      'api-url': { type: 'string' },
      'local-only': { type: 'boolean' },
      'structured-tools': { type: 'boolean' },
    },
  });
  if (v.help) {
    console.log(HELP);
    return;
  }
  if (v.version) {
    console.log(await installedVersion());
    return;
  }
  const command = p[0] ?? 'repl';
  const allowed = new Set([
    'repl',
    'run',
    'doctor',
    'runtime',
    'models',
    'verify',
    'autotune',
    'login',
    'logout',
    'whoami',
    'update',
  ]);
  if (!allowed.has(command)) throw new AxiomError('ARGUMENT', `Unknown command ${command}`);
  if (v.mode && !['fast', 'deep'].includes(v.mode))
    throw new AxiomError('ARGUMENT', '--mode must be fast or deep');
  const root =
    v.cwd || v.project
      ? await realpath(path.resolve(v.cwd ?? v.project!))
      : await discoverRoot(process.cwd());
  const store = new Store();
  const interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY && !v.json);
  const output = (event: Record<string, unknown>): void => {
    if (v.json) process.stdout.write(JSON.stringify(event) + '\n');
    else if (event.type === 'text') process.stdout.write(safeText(String(event.text)));
    else
      console.log(
        safeText(
          typeof event.message === 'string' ? event.message : JSON.stringify(event, null, 2),
        ),
      );
  };
  let rl: Interface | undefined;
  const history = await readJson<string[]>(path.join(store.root, 'input-history.json'), []);
  if (interactive)
    rl = createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: true,
      history: history.slice(0, 100),
      historySize: 100,
    });
  const lifetime = new AbortController();
  let active: AbortController | null = null;
  let quitting = false;
  const cancel = (): void => {
    if (active) {
      active.abort();
      output({
        type: 'notice',
        message: 'Request cancelled; completed edits remain saved and can be undone.',
      });
    } else {
      quitting = true;
      lifetime.abort();
      rl?.close();
    }
  };
  process.on('SIGINT', cancel);
  rl?.on('SIGINT', cancel);
  const terminate = (): void => {
    quitting = true;
    lifetime.abort();
    active?.abort();
    rl?.close();
  };
  process.on('SIGTERM', terminate);
  const grants = (v['allow-command'] ?? []).map((raw) => {
    const args: unknown = JSON.parse(raw);
    if (!Array.isArray(args) || !args.length || args.some((a) => typeof a !== 'string'))
      throw new AxiomError('ARGUMENT', '--allow-command requires a JSON string array');
    return JSON.stringify(args);
  });
  const ask = async (
    req: Approval,
    signal = active?.signal ?? lifetime.signal,
  ): Promise<'once' | 'session' | 'deny'> => {
    output({
      type: 'approval',
      kind: req.kind,
      cwd: req.cwd,
      target: req.target,
      detail: req.detail,
    });
    if (req.kind === 'write' && (v['allow-write'] ?? []).includes(req.target)) return 'once';
    if (req.kind === 'command' && grants.includes(req.target)) return 'once';
    if (req.kind === 'download' && v['approve-download'] === req.target) return 'once';
    if (!rl) return 'deny';
    const answer = (
      await rl.question('Allow once [y], this exact target for session [s], deny [Enter]: ', {
        signal,
      })
    )
      .trim()
      .toLowerCase();
    return ['y', 'yes', 'да'].includes(answer) ? 'once' : answer === 's' ? 'session' : 'deny';
  };
  const permissions = new Permissions(ask);
  const models = new ModelManager(store, permissions);
  const runtime = new RuntimeManager(store, permissions);
  const native = new NativeRuntime();
  const progress = (bytes: number, total: number, rate: number): void =>
    output({ type: 'download-progress', bytes, total, bytesPerSecond: Math.round(rate) });
  const account = (): DeviceAuth => {
    const origin = accountOrigin(v['api-url'] ?? process.env.AXIOM_API_URL ?? '');
    return new DeviceAuth(origin, new OSSecretStore(origin, store));
  };
  const auth = async (action: string, signal: AbortSignal): Promise<void> => {
    const client = account();
    if (action === 'login') {
      await client.login(signal, async (code, url, deadlineSignal) => {
        output({
          type: 'device-code',
          userCode: code,
          verificationUri: url,
          message: `Code: ${code}\nOpen ${url}, sign in and explicitly approve this code.`,
        });
        if (rl) {
          try {
            await openBrowser(
              url,
              new Permissions((req) => ask(req, deadlineSignal)),
              deadlineSignal,
            );
          } catch (e) {
            if (!(e instanceof AxiomError && e.code === 'PERMISSION_DENIED')) throw e;
          }
        }
      });
      output({ type: 'login', message: 'Account token saved in OS-protected storage.' });
    } else if (action === 'logout') {
      await client.logout(signal, v['local-only'] ?? false);
      output({
        type: 'logout',
        message: v['local-only']
          ? 'Local credential removed; remote token was NOT revoked.'
          : 'Remote token revoked and local credential removed.',
      });
    } else output({ type: 'account', ...(await client.whoami(signal)) });
  };
  try {
    if (command === 'update') {
      output({
        type: 'update',
        ...(p[1] === 'install'
          ? await updatePackage(store, permissions, lifetime.signal)
          : {
              latest: await latestVersion(),
              current: await installedVersion(),
              message: 'Use update install for explicit verified update with rollback.',
            }),
      });
      return;
    }
    if (command === 'doctor') {
      output({
        type: 'doctor',
        node: process.version,
        root,
        store: store.root,
        hardware: await detectHardware(),
        runtime: await runtime
          .installed()
          .then((r) => r.record.manifest.id)
          .catch(() => null),
        models: (await models.list()).map((m) => ({ id: m.id, bytes: m.size })),
        accountRequired: false,
        processRecords: await runtime.processRecords(),
        message:
          'GPU detection is not an inference test. Native quickstart: runtime install → models download → run --backend native.',
      });
      return;
    }
    if (command === 'runtime') {
      const action = p[1] ?? 'status';
      if (action === 'install')
        output({
          type: 'runtime-installed',
          record: await runtime.install(lifetime.signal, progress),
        });
      else if (action === 'verify')
        output({ type: 'runtime-verified', message: await runtime.verify() });
      else if (action === 'cleanup')
        output({ type: 'runtime-cleanup', removed: await runtime.cleanupStale() });
      else if (action === 'remove') {
        await runtime.remove();
        output({ type: 'runtime-removed' });
      } else if (action === 'status')
        output({
          type: 'runtime',
          installed: await runtime.installed().catch(() => null),
          catalog: await runtimeCatalog(),
        });
      else throw new AxiomError('ARGUMENT', 'Unknown runtime action');
      return;
    }
    if (command === 'models') {
      const action = p[1] ?? 'list',
        id = p[2] ?? '';
      if (action === 'list') output({ type: 'models', models: await models.list() });
      else if (action === 'search')
        output({
          type: 'models',
          source: 'curated official catalog; no arbitrary hub URLs',
          models: await models.search(id),
        });
      else if (action === 'download')
        output({
          type: 'model-installed',
          model: await models.install(id, lifetime.signal, progress),
        });
      else if (action === 'verify')
        output({ type: 'model-verified', metadata: await models.verify(id) });
      else if (action === 'remove') {
        await models.remove(id);
        output({ type: 'model-removed', id });
      } else if (action === 'import')
        output({
          type: 'model-imported',
          model: await models.import(
            path.resolve(id),
            p[3] ?? '',
            v.license ?? '',
            v.source ?? '',
            lifetime.signal,
          ),
        });
      else throw new AxiomError('ARGUMENT', 'Unknown models action');
      return;
    }
    if (['login', 'logout', 'whoami'].includes(command)) {
      await auth(command, lifetime.signal);
      return;
    }
    const settings = await loadSettings();
    let session = newSession(root, v.model ?? settings.model ?? '', v.url ?? settings.baseUrl);
    session.mode = (v.mode ?? settings.mode) as 'fast' | 'deep';
    let workspace = new Workspace(root, permissions, store, session.id, (file) =>
      output({ type: 'read', file }),
    );
    if (command === 'verify') {
      const result = await verify(workspace, lifetime.signal);
      output({ type: 'verification', ...result });
      if (result.status !== 'passed') process.exitCode = 2;
      return;
    }
    const kind = v.backend ?? 'external';
    if (!['native', 'external'].includes(kind))
      throw new AxiomError('ARGUMENT', '--backend must be native or external');
    const context = numberOption(v.ctx, 4096, 512, 131072);
    let backend: Backend;
    if (kind === 'native') {
      if (!v.model) throw new AxiomError('MODEL', 'Native backend requires --model installed-id');
      await models.verify(v.model);
      const started = await native.start(runtime, await models.file(v.model), {
        signal: lifetime.signal,
        context,
        ...(v['gpu-layers'] !== undefined
          ? { gpuLayers: numberOption(v['gpu-layers'], 0, 0, 1000) }
          : {}),
        cpu: v.cpu ?? false,
      });
      backend = {
        model: started.backend.model,
        baseURL: `native://${v.model}`,
        complete: started.backend.complete.bind(started.backend),
      };
      output({ type: 'runtime-ready', profile: started.profile, gpuEvidence: started.gpuEvidence });
      await writeJSON(path.join(store.root, 'profiles', v.model + '.json'), started.profile);
    } else {
      const url = v.url ?? settings.baseUrl;
      if (!isLoopback(url))
        await permissions.require({
          kind: 'network',
          target: url,
          cwd: root,
          detail: `Send prompts and selected project excerpts to external endpoint ${url}. This may leave your device.`,
        });
      const client = new LMStudioClient(url);
      const available = await client.models(lifetime.signal);
      const model = v.model ?? settings.model ?? available[0];
      if (!model || !available.includes(model))
        throw new AxiomError(
          'MODEL_MISSING',
          'Chosen model is not available. Load it in LM Studio or use --backend native --model ID',
        );
      backend = new OpenAIBackend(url, model, Math.min(1024, Math.floor(context / 4)));
      output({
        type: 'backend',
        message: `External OpenAI-compatible backend: ${url}; model: ${model}. Use --backend native to manage llama.cpp.`,
      });
    }
    if (v['structured-tools']) {
      backend = structuredBackend(backend, output);
    }
    session.model = backend.model;
    session.backend = backend.baseURL;
    await store.save(session);
    if (command === 'autotune') {
      output({
        type: 'calibration',
        ...(await calibrate(backend, store, permissions, lifetime.signal)),
      });
      return;
    }
    const task = async (prompt: string): Promise<void> => {
      if (!prompt.trim()) throw new AxiomError('TASK', 'Task must not be empty');
      active = new AbortController();
      try {
        const result = await runAgent(backend, session, prompt, workspace, store, {
          signal: AbortSignal.any([active.signal, lifetime.signal]),
          onText: (text) => output({ type: 'text', text }),
          onEvent: output,
          verify: v.verify ?? false,
          timeMs: numberOption(v['time-ms'], 300000, 1000, 3600000),
          maxSteps: numberOption(v['max-steps'], session.mode === 'deep' ? 24 : 12, 1, 100),
          contextChars: context * 3,
        });
        output({ type: 'result', sessionId: session.id, ...result });
        if (command === 'run' && result.status !== 'completed') process.exitCode = 2;
      } finally {
        active = null;
      }
    };
    if (command === 'run') {
      await task(p.slice(1).join(' '));
      return;
    }
    if (!rl) throw new AxiomError('TTY', 'Use pilotcode run "task" for noninteractive operation');
    output({
      type: 'ready',
      message: `AxiomPilotCode ${await installedVersion()} · ${root}\nModel: ${session.model} · ${session.mode} · /help`,
    });
    while (!quitting) {
      let input: string;
      try {
        input = (await rl.question('› ')).trim();
      } catch {
        break;
      }
      if (!input) continue;
      if (!input.startsWith('/')) {
        try {
          await task(input);
        } catch (e) {
          output({ type: 'error', ...errorInfo(e) });
        }
        continue;
      }
      const [cmd, ...args] = input.slice(1).split(/\s+/);
      const arg = args.join(' ');
      try {
        switch (cmd) {
          case 'help':
            output({ type: 'help', message: HELP });
            break;
          case 'exit':
          case 'quit':
            quitting = true;
            break;
          case 'clear':
            if (interactive) console.clear();
            break;
          case 'status':
            output({
              type: 'status',
              root,
              sessionId: session.id,
              mode: session.mode,
              model: session.model,
              backend: session.backend,
              status: session.status,
            });
            break;
          case 'config':
            output({
              type: 'config',
              root,
              store: store.root,
              context,
              backend: kind,
              model: backend.model,
              autoUpdateCheck: false,
            });
            break;
          case 'permissions':
            if (arg === 'reset') permissions.clear();
            output({
              type: 'permissions',
              grants: permissions.list(),
              message: 'Grants apply to exact paths or commands. /permissions reset revokes them.',
            });
            break;
          case 'mode':
            if (!['fast', 'deep'].includes(arg))
              throw new AxiomError('MODE', 'Use /mode fast|deep');
            session.mode = arg as 'fast' | 'deep';
            await store.save(session);
            break;
          case 'model':
          case 'models': {
            if (kind === 'native') {
              output({
                type: 'models',
                models: await models.list(),
                message:
                  'To change the native model, exit and restart with --model ID; runtime stops on exit.',
              });
              break;
            }
            const list = await new LMStudioClient(backend.baseURL).models();
            if (!arg) {
              output({ type: 'models', models: list, selected: backend.model });
              break;
            }
            if (!list.includes(arg)) throw new AxiomError('MODEL_MISSING', 'Model not available');
            await store.save(session);
            const mode = session.mode;
            backend = new OpenAIBackend(
              backend.baseURL,
              arg,
              Math.min(1024, Math.floor(context / 4)),
            );
            if (v['structured-tools']) backend = structuredBackend(backend, output);
            session = newSession(root, arg, backend.baseURL);
            session.mode = mode;
            workspace = new Workspace(root, permissions, store, session.id, (file) =>
              output({ type: 'read', file }),
            );
            permissions.clear();
            settings.model = arg;
            await saveSettings(settings);
            await store.save(session);
            break;
          }
          case 'sessions':
            output({ type: 'sessions', sessions: await store.sessions(root) });
            break;
          case 'resume': {
            if (!arg) {
              output({ type: 'sessions', sessions: await store.sessions(root) });
              break;
            }
            const old = await store.load(arg);
            if (old.cwd !== root || old.model !== backend.model || old.backend !== backend.baseURL)
              throw new AxiomError(
                'SESSION_MISMATCH',
                'Resume requires the same project, model and backend URL.',
              );
            session = old;
            workspace = new Workspace(root, permissions, store, session.id, (file) =>
              output({ type: 'read', file }),
            );
            permissions.clear();
            break;
          }
          case 'new': {
            await store.save(session);
            const mode = session.mode;
            session = newSession(root, backend.model, backend.baseURL);
            session.mode = mode;
            workspace = new Workspace(root, permissions, store, session.id, (file) =>
              output({ type: 'read', file }),
            );
            permissions.clear();
            await store.save(session);
            break;
          }
          case 'compact':
            session.messages = compact(session.messages, Math.floor(context * 1.5));
            await store.save(session);
            output({
              type: 'compacted',
              messages: session.messages.length,
              message: 'Kept complete recent turns; no generated summary or invented memory.',
            });
            break;
          case 'undo':
            output({ type: 'undo', message: await workspace.undo() });
            break;
          case 'diff': {
            const checks = await import('./tools.js');
            output({
              type: 'diff',
              message: await new checks.Tools(workspace, lifetime.signal).execute(
                arg ? 'git_diff' : 'git_status',
                arg ? { path: arg } : {},
              ),
            });
            break;
          }
          case 'plan':
            if (!arg) throw new AxiomError('TASK', 'Use /plan task');
            {
              const r = await backend.complete(
                [
                  {
                    role: 'system',
                    content:
                      'Return a concise implementation and validation plan. Do not claim to have executed it.',
                  },
                  { role: 'user', content: arg },
                ],
                [],
                lifetime.signal,
                (text) => output({ type: 'text', text }),
              );
              output({ type: 'plan', message: r.message.content ?? '' });
            }
            break;
          case 'verify':
            output({ type: 'verification', ...(await verify(workspace, lifetime.signal)) });
            break;
          case 'doctor':
            output({
              type: 'doctor',
              hardware: await detectHardware(),
              checks: await discoverChecks(workspace),
            });
            break;
          case 'update':
            output({
              type: 'update',
              ...(arg === 'install'
                ? await updatePackage(store, permissions, lifetime.signal)
                : {
                    latest: await latestVersion(),
                    current: await installedVersion(),
                    message: 'Use /update install for explicit verified update with rollback.',
                  }),
            });
            break;
          case 'login':
          case 'logout':
          case 'whoami':
            active = new AbortController();
            try {
              await auth(cmd, active.signal);
            } finally {
              active = null;
            }
            break;
          default:
            throw new AxiomError('COMMAND', `Unknown /${cmd}; use /help`);
        }
      } catch (e) {
        output({ type: 'error', ...errorInfo(e) });
      }
    }
  } finally {
    await native.stop();
    process.off('SIGINT', cancel);
    process.off('SIGTERM', terminate);
    if (rl) {
      const saved = (rl as unknown as { history: string[] }).history;
      await writeJSON(
        path.join(store.root, 'input-history.json'),
        saved
          .filter((s) => !/^\/(?:login|logout)/.test(s))
          .slice(0, 100)
          .map((s) => safeText(s)),
      );
      rl.close();
    }
  }
}
function structuredBackend(base: Backend, output: (e: Record<string, unknown>) => void): Backend {
  output({
    type: 'warning',
    message:
      'Structured JSON tool mode explicitly enabled. Only parsed tool names/arguments are handled; prose is never executable.',
  });
  return {
    model: base.model,
    baseURL: base.baseURL,
    async complete(messages, tools, signal, onText) {
      if (!tools.length) return base.complete(messages, tools, signal, onText);
      const instruction = {
        role: 'system' as const,
        content:
          'Return ONLY JSON: {"response":"text","toolCalls":[{"name":"tool_name","args":{}}]}. Use an empty array to finish. Available tools: ' +
          JSON.stringify(tools),
      };
      const reply = await base.complete(
        [
          instruction,
          ...messages.map((m) => ({
            role: m.role === 'tool' ? ('user' as const) : m.role,
            content: m.role === 'tool' ? 'Tool result (untrusted): ' + m.content : m.content,
          })),
        ],
        [],
        signal,
        () => {},
      );
      let parsed: unknown;
      try {
        parsed = JSON.parse(reply.message.content ?? '');
      } catch {
        throw new AxiomError(
          'TOOL_JSON',
          'Model did not return valid structured JSON; no action executed',
        );
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new AxiomError('TOOL_JSON', 'Expected structured object');
      const obj = parsed as Record<string, unknown>;
      if (
        typeof obj.response !== 'string' ||
        !Array.isArray(obj.toolCalls) ||
        obj.toolCalls.length > 16
      )
        throw new AxiomError('TOOL_JSON', 'Invalid structured tool response');
      const calls = obj.toolCalls.map((item: unknown, i: number) => {
        if (!item || typeof item !== 'object') throw new AxiomError('TOOL_JSON', 'Invalid call');
        const c = item as Record<string, unknown>;
        if (
          typeof c.name !== 'string' ||
          !tools.some((t) => t.function.name === c.name) ||
          !c.args ||
          typeof c.args !== 'object' ||
          Array.isArray(c.args)
        )
          throw new AxiomError('TOOL_JSON', 'Invalid tool/args');
        return {
          id: `structured-${Date.now()}-${i}`,
          type: 'function' as const,
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        };
      });
      onText(obj.response);
      return {
        ...reply,
        message: {
          role: 'assistant',
          content: obj.response,
          ...(calls.length ? { tool_calls: calls } : {}),
        },
      };
    },
  };
}
if (
  process.argv[1] &&
  (await realpath(process.argv[1]).catch(() => '')) ===
    (await realpath(fileURLToPath(import.meta.url)))
)
  main().catch((error) => {
    const info = errorInfo(error);
    if (process.argv.includes('--json')) console.log(JSON.stringify({ type: 'error', ...info }));
    else console.error(safeText(`pilotcode [${info.code}]: ${info.message}`));
    process.exitCode = info.code === 'CANCELLED' ? 130 : 1;
  });
