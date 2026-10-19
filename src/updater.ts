import { readFile } from 'node:fs/promises';
import { AxiomError } from './core.js';
export const PACKAGE_NAME = 'axiom-pilot-code';
export function versionCompare(a: string, b: string): number {
  const parse = (v: string) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v);
    if (!m) throw new AxiomError('VERSION', 'Invalid SemVer');
    return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4]?.split('.') };
  };
  const x = parse(a),
    y = parse(b);
  for (let i = 0; i < 3; i++)
    if (x.core[i] !== y.core[i]) return Math.sign(x.core[i]! - y.core[i]!);
  if (!x.pre && !y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const l = x.pre[i],
      r = y.pre[i];
    if (l === r) continue;
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const ln = /^\d+$/.test(l),
      rn = /^\d+$/.test(r);
    if (ln && rn) return Math.sign(Number(l) - Number(r));
    if (ln !== rn) return ln ? -1 : 1;
    return l < r ? -1 : 1;
  }
  return 0;
}
export async function installedVersion(): Promise<string> {
  return (
    JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    }
  ).version;
}
export async function latestVersion(signal = AbortSignal.timeout(6000)): Promise<string | null> {
  const r = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, {
    signal,
    redirect: 'error',
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new AxiomError('UPDATE', `npm HTTP ${r.status}`);
  const data = (await r.json()) as { version: string };
  versionCompare(data.version, '0.0.0');
  return data.version;
}

/** Explicit update only. Stage and verify npm's SRI, retain a locally packed rollback. */
export async function updatePackage(
  store: import('./storage.js').Store,
  permissions: import('./core.js').Permissions,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const { mkdir, writeFile, rm } = await import('node:fs/promises');
  const { createHash, randomUUID } = await import('node:crypto');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { runCommand, npmCommand } = await import('./command.js');
  const response = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, {
    signal,
    redirect: 'error',
  });
  if (response.status === 404)
    throw new AxiomError('UPDATE_UNPUBLISHED', 'Package is not published; no update was installed');
  if (!response.ok) throw new AxiomError('UPDATE', `Registry HTTP ${response.status}`);
  const metadata = (await response.json()) as {
    name: string;
    version: string;
    repository?: { url?: string };
    dist?: { tarball?: string; integrity?: string };
  };
  const current = await installedVersion();
  if (
    metadata.name !== PACKAGE_NAME ||
    !metadata.repository?.url
      ?.replace(/\.git$/, '')
      .endsWith('github.com/zaoastronaftik-bit/axiom-pilot-code')
  )
    throw new AxiomError(
      'UPDATE_PROVENANCE',
      'Registry package does not identify the expected source repository',
    );
  if (versionCompare(metadata.version, current) <= 0)
    return { status: 'current', current, available: metadata.version };
  const integrity = metadata.dist?.integrity,
    tarball = metadata.dist?.tarball;
  if (!integrity?.startsWith('sha512-') || !tarball)
    throw new AxiomError('UPDATE_INTEGRITY', 'Registry release lacks SHA512 integrity');
  const url = new URL(tarball);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'registry.npmjs.org' ||
    !url.pathname.startsWith('/axiom-pilot-code/-/') ||
    url.username ||
    url.password ||
    url.search
  )
    throw new AxiomError('UPDATE_PROVENANCE', 'Unexpected npm tarball origin');
  const destination = path.join(store.root, 'updates', randomUUID());
  await permissions.require({
    kind: 'download',
    target: `axiom-pilot-code@${metadata.version}`,
    cwd: destination,
    detail: JSON.stringify(
      {
        source: tarball,
        integrity,
        version: metadata.version,
        limitBytes: 25000000,
        license: 'MIT',
        operation: 'Stage update; npm global install requires separate command approval',
        rollback: 'Current package is packed locally before replacement',
      },
      null,
      2,
    ),
  });
  signal.throwIfAborted();
  const archive = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
    redirect: 'error',
  });
  if (!archive.ok || !archive.body)
    throw new AxiomError('UPDATE_DOWNLOAD', 'Cannot download update');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of archive.body) {
    bytes += chunk.byteLength;
    if (bytes > 25000000) throw new AxiomError('UPDATE_SIZE', 'Update exceeds 25 MB safety limit');
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  if ('sha512-' + createHash('sha512').update(buffer).digest('base64') !== integrity)
    throw new AxiomError('UPDATE_INTEGRITY', 'Update SHA512 mismatch');
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const file = path.join(destination, `update-${metadata.version}.tgz`);
  await writeFile(file, buffer, { flag: 'wx', mode: 0o600 });
  const backupDir = path.join(destination, 'rollback');
  await mkdir(backupDir);
  const installedRoot = fileURLToPath(new URL('../', import.meta.url));
  const pack = await npmCommand([
    'pack',
    '--ignore-scripts',
    '--json',
    '--pack-destination',
    backupDir,
  ]);
  const packed = await runCommand(pack.program, pack.args, installedRoot, {
    signal,
    timeoutMs: 60000,
  });
  if (packed.exitCode !== 0)
    throw new AxiomError('UPDATE_BACKUP', 'Cannot create rollback package; update not attempted');
  let backupName: string;
  try {
    backupName = (JSON.parse(packed.stdout) as { filename: string }[])[0]!.filename;
  } catch {
    throw new AxiomError('UPDATE_BACKUP', 'Invalid npm pack response');
  }
  if (path.basename(backupName) !== backupName)
    throw new AxiomError('UPDATE_BACKUP', 'Unexpected rollback filename');
  const backup = path.join(backupDir, backupName);
  const install = await npmCommand(['install', '--global', '--ignore-scripts', file]);
  await permissions.require({
    kind: 'command',
    target: JSON.stringify([install.program, ...install.args]),
    cwd: installedRoot,
    detail: `Install verified ${metadata.version} globally. On failure, reinstall ${backup}. No lifecycle scripts will run.`,
  });
  signal.throwIfAborted();
  const result = await runCommand(install.program, install.args, installedRoot, {
    signal,
    timeoutMs: 120000,
  });
  if (result.exitCode !== 0 || result.timedOut || result.cancelled) {
    const rollback = await npmCommand(['install', '--global', '--ignore-scripts', backup]);
    const restored = await runCommand(rollback.program, rollback.args, installedRoot, {
      timeoutMs: 120000,
    });
    throw new AxiomError(
      'UPDATE_FAILED',
      `Update failed; rollback ${restored.exitCode === 0 ? 'completed' : 'also failed'}. Recovery archive retained: ${backup}`,
    );
  }
  await rm(file);
  return {
    status: 'installed',
    version: metadata.version,
    rollback: backup,
    message:
      'Restart pilotcode. Rollback archive retained; npm publication/deployment not performed by this command.',
  };
}
