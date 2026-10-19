import { spawn } from 'node:child_process';
import { readFile, unlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AxiomError, Permissions, object, string, integer, sha256 } from './core.js';
import { Store, atomicWrite } from './storage.js';
import { minimalEnv, terminateTree } from './command.js';
export interface SecretStore {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
  delete(): Promise<void>;
}
async function secretProcess(program: string, args: string[], input = ''): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: minimalEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    const timer = setTimeout(() => {
      void terminateTree(child);
      reject(new AxiomError('SECRET_STORE', 'OS secret store timed out'));
    }, 15000);
    child.stdout.on('data', (d: Buffer) => {
      output += d.toString();
      if (output.length > 16384) {
        void terminateTree(child);
        reject(new AxiomError('SECRET_STORE', 'Unexpected OS secret-store output'));
      }
    });
    child.stderr.resume();
    child.once('error', () => {
      clearTimeout(timer);
      reject(new AxiomError('SECRET_STORE', 'OS secret store unavailable; no plaintext fallback'));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new AxiomError('SECRET_STORE', 'OS secret store operation failed'));
      else resolve(output.trim());
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
export class OSSecretStore implements SecretStore {
  private file: string;
  constructor(
    private readonly origin: string,
    store: Store,
  ) {
    this.file = path.join(store.root, 'auth', sha256(origin) + '.dpapi');
  }
  private async dpapi(operation: 'protect' | 'unprotect', value: string): Promise<string> {
    const script =
      `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd(); ` +
      (operation === 'protect'
        ? '$b=[Text.Encoding]::UTF8.GetBytes($v); $o=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($o))'
        : '$b=[Convert]::FromBase64String($v); $o=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($o))');
    const exe = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    return secretProcess(
      exe,
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      value,
    );
  }
  async get(): Promise<string | null> {
    if (process.platform === 'win32') {
      let encrypted;
      try {
        encrypted = await readFile(this.file, 'utf8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw e;
      }
      return this.dpapi('unprotect', encrypted);
    }
    if (process.platform === 'linux') {
      try {
        return (
          (await secretProcess('secret-tool', [
            'lookup',
            'service',
            'axiompilotcode',
            'origin',
            this.origin,
          ])) || null
        );
      } catch {
        return null;
      }
    }
    throw new AxiomError(
      'SECRET_STORE',
      'Account login is not yet supported on this OS; local inference works offline',
    );
  }
  async set(value: string): Promise<void> {
    if (process.platform === 'win32') {
      const encrypted = await this.dpapi('protect', value);
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      await atomicWrite(this.file, encrypted);
      return;
    }
    if (process.platform === 'linux') {
      await secretProcess(
        'secret-tool',
        ['store', '--label=AxiomPilotCode CLI', 'service', 'axiompilotcode', 'origin', this.origin],
        value,
      );
      return;
    }
    throw new AxiomError(
      'SECRET_STORE',
      'No supported OS credential store; token will not be saved',
    );
  }
  async delete(): Promise<void> {
    if (process.platform === 'win32') {
      await unlink(this.file).catch((e) => {
        if (e.code !== 'ENOENT') throw e;
      });
      return;
    }
    if (process.platform === 'linux') {
      await secretProcess('secret-tool', [
        'clear',
        'service',
        'axiompilotcode',
        'origin',
        this.origin,
      ]);
      return;
    }
    throw new AxiomError('SECRET_STORE', 'Unsupported OS credential store');
  }
}
export function accountOrigin(input: string): string {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    throw new AxiomError(
      'ACCOUNT_UNAVAILABLE',
      'Account service temporarily unavailable: configure a deployed HTTPS API with --api-url or AXIOM_API_URL',
    );
  }
  if (
    u.protocol !== 'https:' ||
    u.username ||
    u.password ||
    u.pathname !== '/' ||
    u.search ||
    u.hash
  )
    throw new AxiomError('ACCOUNT_URL', 'Account API must be an HTTPS origin');
  return u.origin;
}
export class DeviceAuth {
  readonly origin: string;
  constructor(
    origin: string,
    private readonly secrets: SecretStore,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.origin = accountOrigin(origin);
  }
  private async request(
    route: string,
    body: unknown | undefined,
    signal: AbortSignal,
    token?: string,
  ): Promise<Response> {
    let r: Response;
    try {
      r = await this.fetcher(this.origin + route, {
        method: body === undefined ? 'GET' : 'POST',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      });
    } catch {
      signal.throwIfAborted();
      throw new AxiomError('ACCOUNT_UNAVAILABLE', 'Account service temporarily unavailable');
    }
    if (!r.ok) {
      await r.body?.cancel();
      throw new AxiomError(
        r.status === 401 ? 'ACCOUNT_UNAUTHORIZED' : 'ACCOUNT_UNAVAILABLE',
        r.status === 401
          ? 'Account token invalid or expired'
          : `Account service temporarily unavailable (HTTP ${r.status})`,
      );
    }
    return r;
  }
  async login(
    signal: AbortSignal,
    show: (code: string, url: string, signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    if (await this.secrets.get())
      throw new AxiomError(
        'ACCOUNT_EXISTS',
        'Already have an account token; use whoami or logout first',
      );
    const started = Date.now();
    const start = object(await (await this.request('/api/device?action=start', {}, signal)).json());
    const deviceCode = string(start.deviceCode, 'deviceCode', 128),
      userCode = string(start.userCode, 'userCode', 32),
      verificationUri = string(start.verificationUri, 'verificationUri', 2048);
    if (
      !/^[A-Za-z0-9_-]{40,50}$/.test(deviceCode) ||
      !/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(userCode)
    )
      throw new AxiomError('ACCOUNT_PROTOCOL', 'Invalid device-code response');
    const uri = new URL(verificationUri);
    if (uri.protocol !== 'https:' || uri.username || uri.password)
      throw new AxiomError('ACCOUNT_PROTOCOL', 'Invalid verification URL');
    let interval = integer(start.interval, 'interval', 1, 600);
    const expires = integer(start.expiresIn, 'expiresIn', 1, 3600);
    const deadline = started + Math.min(expires * 1000, 600000);
    const combined = AbortSignal.any([
      signal,
      AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    ]);
    await show(userCode, verificationUri, combined);
    combined.throwIfAborted();
    while (Date.now() < deadline) {
      await delay(interval * 1000, undefined, { signal: combined });
      combined.throwIfAborted();
      const response = await this.request('/api/device?action=poll', { deviceCode }, combined);
      const body = object(await response.json());
      if (response.status === 202) {
        if (body.status !== 'pending')
          throw new AxiomError('ACCOUNT_PROTOCOL', 'Invalid pending response');
        if (body.interval !== undefined)
          interval = Math.max(interval, integer(body.interval, 'interval', 1, 600));
        continue;
      }
      const token = string(body.accessToken, 'accessToken', 128);
      if (body.status !== 'authorized' || !/^axiom_cli_[A-Za-z0-9_-]{40,50}$/.test(token))
        throw new AxiomError('ACCOUNT_PROTOCOL', 'Invalid authorization response');
      try {
        await this.secrets.set(token);
      } catch (error) {
        await this.request('/api/cli?action=revoke', {}, AbortSignal.timeout(10000), token).catch(
          () => {},
        );
        throw error;
      }
      return;
    }
    throw new AxiomError('ACCOUNT_EXPIRED', 'Device authorization expired');
  }
  async whoami(signal: AbortSignal): Promise<Record<string, unknown>> {
    const token = await this.secrets.get();
    if (!token) return { authenticated: false };
    const body = object(await (await this.request('/api/cli', undefined, signal, token)).json());
    return {
      authenticated: body.authenticated === true,
      plan: body.plan,
      userId: body.userId,
      tokenId: body.tokenId,
    };
  }
  async logout(signal: AbortSignal, localOnly = false): Promise<void> {
    const token = await this.secrets.get();
    if (token && !localOnly) await this.request('/api/cli?action=revoke', {}, signal, token);
    await this.secrets.delete();
  }
}
export async function openBrowser(
  url: string,
  permissions: Permissions,
  signal?: AbortSignal,
): Promise<void> {
  await permissions.require({
    kind: 'browser',
    target: url,
    cwd: process.cwd(),
    detail: `Open ${url}. You must sign in and approve the displayed code yourself.`,
  });
  signal?.throwIfAborted();
  if (process.platform === 'win32') {
    // Invoke ShellExecute through a fixed PowerShell script, URL as stdin, never shell interpolation.
    const script = '$u=[Console]::In.ReadToEnd(); Start-Process -FilePath $u';
    await secretProcess(
      path.join(
        process.env.SystemRoot || 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      ),
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      url,
    );
  } else await secretProcess(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]);
}
