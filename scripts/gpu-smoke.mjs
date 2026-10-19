#!/usr/bin/env node
// Real hardware gate. Missing hardware/model is a failure, never a green skip.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store, newSession } from '../dist/storage.js';
import { Permissions } from '../dist/core.js';
import { RuntimeManager, NativeRuntime } from '../dist/runtime.js';
import { ModelManager } from '../dist/models.js';
import { detectHardware } from '../dist/hardware.js';
import { Workspace } from '../dist/workspace.js';
import { runAgent } from '../dist/agent.js';
import { npmCommand } from '../dist/command.js';
if (process.platform !== 'win32')
  throw new Error(
    'Acceptance requires Windows 11 x64 and NVIDIA GPU; not validated on this machine',
  );
const hardware = await detectHardware();
if (!hardware.gpus.some((g) => g.totalMiB >= 11000))
  throw new Error('Acceptance requires measured NVIDIA GPU with at least ~12 GB VRAM');
if (process.env.AXIOM_GPU_SMOKE_CONSENT !== 'yes')
  throw new Error(
    'Set AXIOM_GPU_SMOKE_CONSENT=yes to approve disposable fixture edits and its Node test command. No downloads occur.',
  );
const store = new Store(),
  id = process.env.AXIOM_SMOKE_MODEL || 'qwen2.5-coder-7b-q4_k_m';
const command = await npmCommand(['run', 'test']);
const commandTarget = JSON.stringify([command.program, ...command.args]);
const permissions = new Permissions(async (req) =>
  (req.kind === 'write' && req.target === 'sum.mjs') ||
  (req.kind === 'command' && req.target === commandTarget)
    ? 'once'
    : 'deny',
);
const models = new ModelManager(store, permissions);
await models.verify(id);
const manager = new RuntimeManager(store, permissions),
  runtime = new NativeRuntime();
const dir = await mkdtemp(path.join(os.tmpdir(), 'axiom-gpu-smoke-'));
const root = path.join(dir, 'project');
await mkdir(root);
await writeFile(path.join(root, 'sum.mjs'), 'export const sum=(a,b)=>a-b;\n');
await writeFile(
  path.join(root, 'package.json'),
  JSON.stringify({ type: 'module', scripts: { test: 'node --test test.mjs' } }),
);
await writeFile(
  path.join(root, 'test.mjs'),
  'import {sum} from "./sum.mjs";import assert from "node:assert/strict";assert.equal(sum(2,3),5);assert.equal(sum(-1,1),0);',
);
try {
  const started = await runtime.start(manager, await models.file(id), {
    signal: AbortSignal.timeout(180000),
    context: 4096,
  });
  assert.ok(started.gpuEvidence.length);
  const session = newSession(root, started.backend.model, started.backend.baseURL);
  const workspace = new Workspace(root, permissions, store, session.id);
  const result = await runAgent(
    started.backend,
    session,
    'Fix sum.mjs to add its two numbers. Read it first, edit only sum.mjs, then finish.',
    workspace,
    store,
    { signal: AbortSignal.timeout(300000), verify: true },
  );
  assert.equal(result.verification?.status, 'passed');
  assert.equal((await store.load(session.id)).status, 'completed');
  assert.match(await readFile(path.join(root, 'sum.mjs'), 'utf8'), /\+/);
  console.log(
    JSON.stringify(
      {
        status: 'passed',
        hardware,
        profile: started.profile,
        gpuEvidence: started.gpuEvidence,
        result,
        sessionId: session.id,
      },
      null,
      2,
    ),
  );
} finally {
  await runtime.stop();
  await rm(dir, { recursive: true, force: true });
}
