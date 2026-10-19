import os from 'node:os';
import { runCommand } from './command.js';
import type { GGUF } from './gguf.js';
import { AxiomError } from './core.js';
export interface Hardware {
  platform: string;
  arch: string;
  cpu: string;
  cores: number;
  ramTotal: number;
  ramFree: number;
  gpus: { index: number; name: string; totalMiB: number; freeMiB: number; driver: string }[];
  gpuDiagnostic: string;
}
export async function detectHardware(): Promise<Hardware> {
  const h: Hardware = {
    platform: process.platform,
    arch: process.arch,
    cpu: os.cpus()[0]?.model ?? 'unknown',
    cores: os.availableParallelism(),
    ramTotal: os.totalmem(),
    ramFree: os.freemem(),
    gpus: [],
    gpuDiagnostic: 'NVIDIA GPU not detected; no GPU readiness claim',
  };
  try {
    const r = await runCommand(
      'nvidia-smi',
      [
        '--query-gpu=index,name,memory.total,memory.free,driver_version',
        '--format=csv,noheader,nounits',
      ],
      process.cwd(),
      { timeoutMs: 5000 },
    );
    if (r.exitCode === 0) {
      for (const line of r.stdout.trim().split('\n')) {
        const [index, name, total, free, driver] = line.split(',').map((s) => s.trim());
        if (
          name &&
          driver &&
          Number.isFinite(Number(total)) &&
          Number.isFinite(Number(free)) &&
          Number(total) > 0
        )
          h.gpus.push({
            index: Number(index),
            name,
            totalMiB: Number(total),
            freeMiB: Number(free),
            driver,
          });
      }
      h.gpuDiagnostic = h.gpus.length
        ? 'Measured by nvidia-smi; inference not yet validated'
        : h.gpuDiagnostic;
    }
  } catch {
    /* unavailable is an observation, not CPU performance prediction */
  }
  return h;
}
export interface RuntimeProfile {
  schema: 1;
  context: number;
  gpuLayers: number;
  gpuIndex: number;
  threads: number;
  parallel: 1;
  estimatedGpuMiB: number;
  estimatedHostMiB: number;
  approximate: true;
  recommendations: string[];
}
export function recommend(
  h: Hardware,
  gguf: GGUF,
  options: { context?: number; gpuLayers?: number; cpu?: boolean } = {},
): RuntimeProfile {
  const context = options.context ?? 4096;
  if (!Number.isInteger(context) || context < 512 || context > 131072)
    throw new AxiomError('CONTEXT', 'Context must be 512..131072');
  const arch = String(gguf.metadata['general.architecture'] ?? '');
  const num = (key: string) => Number(gguf.metadata[arch + '.' + key]);
  const layers = num('block_count'),
    embedding = num('embedding_length'),
    heads = num('attention.head_count'),
    kvHeads = num('attention.head_count_kv');
  if (![layers, embedding, heads, kvHeads].every((v) => Number.isFinite(v) && v > 0))
    throw new AxiomError(
      'MODEL_METADATA',
      'Cannot estimate memory: supported dense-model GGUF layer/attention metadata is required',
    );
  const kvBytes = context * layers * kvHeads * (embedding / heads) * 4;
  const weights = gguf.fileBytes;
  const gpu = options.cpu ? undefined : h.gpus[0];
  const reserve = 1536 * 1024 ** 2;
  const available = gpu ? Math.max(0, gpu.freeMiB * 1024 ** 2 - reserve - kvBytes) : 0;
  const auto = gpu
    ? Math.min(layers + 1, Math.max(0, Math.floor(available / (weights / (layers + 1)))))
    : 0;
  const gpuLayers = options.gpuLayers ?? auto;
  if (!Number.isInteger(gpuLayers) || gpuLayers < 0 || gpuLayers > layers + 1)
    throw new AxiomError('OFFLOAD', 'Invalid GPU layers for this model');
  if (gpuLayers > 0 && !gpu)
    throw new AxiomError(
      'GPU_UNAVAILABLE',
      'GPU offload requested but NVIDIA measurement unavailable',
    );
  const host = weights + kvBytes + 1024 ** 3;
  if (host > h.ramFree * 0.8)
    throw new AxiomError(
      'MEMORY',
      'Conservative host-memory estimate exceeds 80% of free RAM; choose a smaller model/context or close applications. Swap is not an automatic fallback',
    );
  const gpuBytes = (weights * gpuLayers) / (layers + 1) + (gpuLayers ? kvBytes + reserve : 0);
  if (gpu && gpuBytes > gpu.freeMiB * 1024 ** 2)
    throw new AxiomError('VRAM', 'Requested offload/context exceeds measured free VRAM estimate');
  return {
    schema: 1,
    context,
    gpuLayers,
    gpuIndex: gpu?.index ?? 0,
    threads: Math.max(1, Math.min(h.cores - 1, 12)),
    parallel: 1,
    estimatedGpuMiB: Math.ceil(gpuBytes / 1024 ** 2),
    estimatedHostMiB: Math.ceil(host / 1024 ** 2),
    approximate: true,
    recommendations: [
      `Approximate dense-model estimate; runtime health and allocation logs must confirm. GPU offload=${gpuLayers}/${layers + 1}, ctx=${context}.`,
      ...(gpuLayers < layers + 1
        ? ['Partial/CPU offload; performance has not been measured.']
        : []),
      ...(!gpu ? ['No measured NVIDIA GPU. CPU start requires --cpu.'] : []),
    ],
  };
}
