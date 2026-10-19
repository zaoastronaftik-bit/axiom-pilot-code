import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

export const PACKAGE_NAME = 'axiom-pilot-code';

export function versionCompare(a, b) {
  const parse = v => String(v).split('-')[0].split('.').map(n => Number(n));
  const aa = parse(a), bb = parse(b);
  for (let i = 0; i < 3; i++) { if ((aa[i] || 0) !== (bb[i] || 0)) return Math.sign((aa[i] || 0) - (bb[i] || 0)); }
  return 0;
}

export async function installedVersion() {
  return JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
}

export async function latestVersion(signal = AbortSignal.timeout(6_000)) {
  const response = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, { signal });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`);
  const data = await response.json();
  return data.version;
}

export function installUpdate() {
  // Known constant package name; no model-controlled parameters.
  const win = process.platform === 'win32';
  const cmd = win ? 'npm.cmd' : 'npm';
  return spawnSync(cmd, ['install', '-g', `${PACKAGE_NAME}@latest`], {
    stdio: 'inherit', shell: win, windowsHide: false,
  });
}
