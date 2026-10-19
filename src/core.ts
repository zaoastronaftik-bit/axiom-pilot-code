import { randomUUID, createHash } from 'node:crypto';

export class AxiomError extends Error {
  readonly id = randomUUID();
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'AxiomError';
  }
}
export const sha256 = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AxiomError('INVALID_INPUT', 'Expected an object');
  return value as Record<string, unknown>;
}
export function string(value: unknown, name: string, max = 262144): string {
  if (typeof value !== 'string' || value.length > max)
    throw new AxiomError('INVALID_INPUT', `Invalid ${name}`);
  return value;
}
export function integer(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    throw new AxiomError('INVALID_INPUT', `Invalid ${name}: expected ${min}..${max}`);
  return value;
}
export function redact(value: string): string {
  return value
    .replace(/(Bearer\s+)[\w.\-]+/gi, '$1[REDACTED]')
    .replace(/axiom_cli_[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
      '[REDACTED KEY]',
    )
    .replace(/((?:api[_-]?key|password|secret|token)\s*[=:]\s*["']?)[^\s"',;]+/gi, '$1[REDACTED]');
}
export function safeText(text: string): string {
  return redact(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}
export function errorInfo(error: unknown): { code: string; message: string; id?: string } {
  return error instanceof AxiomError
    ? { code: error.code, message: redact(error.message), id: error.id }
    : {
        code: error instanceof Error && error.name === 'AbortError' ? 'CANCELLED' : 'ERROR',
        message: redact(error instanceof Error ? error.message : String(error)),
      };
}
export type Decision = 'once' | 'session' | 'deny';
export interface Approval {
  kind: 'write' | 'command' | 'download' | 'network' | 'browser';
  target: string;
  detail: string;
  cwd: string;
}
export type Approve = (request: Approval) => Promise<Decision>;
export class Permissions {
  private grants = new Set<string>();
  constructor(private readonly approve: Approve) {}
  clear(): void {
    this.grants.clear();
  }
  list(): string[] {
    return [...this.grants];
  }
  async require(request: Approval): Promise<void> {
    const key = JSON.stringify([request.kind, request.cwd, request.target]);
    if (this.grants.has(key)) return;
    const decision = await this.approve(request);
    if (decision !== 'once' && decision !== 'session')
      throw new AxiomError('PERMISSION_DENIED', `${request.kind} denied: ${request.target}`);
    if (decision === 'session') this.grants.add(key);
  }
}
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
export interface ToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}
export interface Completion {
  message: Message;
  usage: { prompt_tokens?: number; completion_tokens?: number };
  ttftMs: number | null;
  elapsedMs: number;
  finishReason: string | null;
}
export interface Backend {
  readonly model: string;
  readonly baseURL: string;
  complete(
    messages: Message[],
    tools: ToolDefinition[],
    signal: AbortSignal,
    onText: (text: string) => void,
  ): Promise<Completion>;
}
