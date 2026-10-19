#!/usr/bin/env node
// Test the packaged artifact, including the POSIX npm bin symlink.
import { mkdtemp, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { npmCommand, runCommand, minimalEnv } from '../dist/command.js';
const root = fileURLToPath(new URL('../', import.meta.url));
const temp = await mkdtemp(path.join(os.tmpdir(), 'axiom-package-'));
async function npm(args) {
  const cmd = await npmCommand(args);
  const r = await runCommand(cmd.program, cmd.args, root, { timeoutMs: 120000 });
  assert.equal(r.exitCode, 0, r.stderr + r.stdout);
  return r.stdout;
}
try {
  const pack = JSON.parse(
    await npm(['pack', '--ignore-scripts', '--json', '--pack-destination', temp]),
  )[0];
  const prefix = path.join(temp, 'installed');
  await npm([
    'install',
    '--global',
    '--prefix',
    prefix,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    path.join(temp, pack.filename),
  ]);
  const windows = process.platform === 'win32';
  const shim = path.join(prefix, windows ? 'pilotcode.cmd' : 'bin/pilotcode');
  await access(shim);
  const program = windows ? process.execPath : shim;
  const before = windows ? [path.join(prefix, 'node_modules/axiom-pilot-code/dist/cli.js')] : [];
  const run = (args) =>
    runCommand(program, [...before, ...args], temp, {
      timeoutMs: 15000,
      env: { ...minimalEnv(), PILOTCODE_HOME: path.join(temp, 'state') },
    });
  const version = await run(['--version']);
  assert.equal(version.exitCode, 0, version.stderr);
  assert.equal(version.stdout.trim(), '1.0.0-alpha.1');
  const search = await run(['models', 'search', 'qwen', '--json']);
  assert.equal(search.exitCode, 0, search.stderr);
  assert.equal(JSON.parse(search.stdout).models[0].id, 'qwen2.5-coder-7b-q4_k_m');
  const doctor = await run(['doctor', '--json']);
  assert.equal(doctor.exitCode, 0, doctor.stderr);
  assert.equal(JSON.parse(doctor.stdout).accountRequired, false);
  console.log(
    'PASS: packed artifact, isolated npm prefix, installed version/catalog/doctor; no model/GPU claim.',
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
