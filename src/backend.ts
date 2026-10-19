import { setTimeout as delay } from 'node:timers/promises';
import {
  AxiomError,
  object,
  string,
  type Backend,
  type Completion,
  type Message,
  type ToolCall,
  type ToolDefinition,
} from './core.js';

export function backendURL(input: string): URL {
  const url = new URL(input);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new AxiomError(
      'BACKEND_URL',
      'Expected HTTP(S) base URL without credentials, query or fragment',
    );
  if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    throw new AxiomError('BACKEND_URL', 'Unencrypted HTTP is permitted only on loopback');
  return url;
}
export const isLoopback = (input: string): boolean =>
  ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(input).hostname);
interface ChatOptions {
  model: string;
  messages: Message[];
  tools?: ToolDefinition[];
  onText?: (text: string) => void;
  signal?: AbortSignal;
  maxTokens?: number;
  seed?: number;
  structured?: boolean;
}
export class LMStudioClient {
  readonly baseUrl: string;
  constructor(
    baseUrl: string,
    private readonly apiKey = process.env.PILOTCODE_API_KEY,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.baseUrl = backendURL(baseUrl).toString().replace(/\/$/, '');
  }
  async request(route: string, options: RequestInit = {}): Promise<Response> {
    const signal = AbortSignal.any([
      options.signal ?? new AbortController().signal,
      AbortSignal.timeout(180000),
    ]);
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      let response: Response;
      try {
        response = await this.fetcher(this.baseUrl + route, {
          ...options,
          redirect: 'error',
          signal,
          headers: {
            ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            ...options.headers,
          },
        });
      } catch (cause) {
        if (signal.aborted) throw new AxiomError('CANCELLED', 'Request cancelled or timed out');
        if (attempt < 2) {
          await delay(250 * 2 ** attempt, undefined, { signal });
          continue;
        }
        throw new AxiomError('BACKEND_UNAVAILABLE', `Cannot connect to backend ${this.baseUrl}`, {
          cause,
        });
      }
      if (response.ok) return response;
      if ([408, 429, 502, 503, 504].includes(response.status) && attempt < 2) {
        const retry = Number(response.headers.get('retry-after'));
        await response.body?.cancel();
        await delay(
          Math.min(10000, Math.max(250 * 2 ** attempt, Number.isFinite(retry) ? retry * 1000 : 0)),
          undefined,
          { signal },
        );
        continue;
      }
      await response.body?.cancel();
      throw new AxiomError(
        response.status === 400 ? 'BACKEND_REQUEST' : 'BACKEND_HTTP',
        `Backend HTTP ${response.status}; check model/tools compatibility and runtime logs`,
      );
    }
  }
  async models(signal?: AbortSignal): Promise<string[]> {
    const response = await this.request('/models', signal ? { signal } : {});
    const body = object(await response.json());
    if (!Array.isArray(body.data))
      throw new AxiomError('BACKEND_PROTOCOL', 'Invalid models response');
    return body.data
      .map((item) => object(item).id)
      .filter((v): v is string => typeof v === 'string' && v.length > 0);
  }
  async chat(
    options: ChatOptions,
  ): Promise<{ content: string; toolCalls: ToolCall[] } & Completion> {
    const start = performance.now();
    let first: number | null = null;
    const tools = options.tools ?? [];
    const signal = AbortSignal.any([
      options.signal ?? new AbortController().signal,
      AbortSignal.timeout(180000),
    ]);
    const body = {
      model: options.model,
      messages: options.messages,
      temperature: 0.2,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: options.maxTokens ?? 1024,
      seed: options.seed ?? 42,
      ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
      ...(options.structured ? { response_format: { type: 'json_object' } } : {}),
    };
    const response = await this.request('/chat/completions', {
      method: 'POST',
      body: JSON.stringify(body),
      signal,
    });
    if (!response.body) throw new AxiomError('BACKEND_PROTOCOL', 'Missing response stream');
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const calls = new Map<number, ToolCall>();
    let content = '',
      buffer = '',
      doneMarker = false,
      finishReason: string | null = null,
      received = 0;
    let usage: Completion['usage'] = {};
    const parseBlock = (block: string): void => {
      const payload = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
        .trim();
      if (!payload) return;
      if (payload === '[DONE]') {
        doneMarker = true;
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        throw new AxiomError('SSE_JSON', 'Malformed streaming JSON');
      }
      const json = object(parsed);
      if (json.error)
        throw new AxiomError('BACKEND_PROTOCOL', 'Backend returned a streaming error');
      if (json.usage && typeof json.usage === 'object') {
        const u = object(json.usage);
        for (const key of ['prompt_tokens', 'completion_tokens'] as const)
          if (typeof u[key] === 'number' && Number.isSafeInteger(u[key]) && u[key] >= 0)
            usage[key] = u[key];
      }
      if (!Array.isArray(json.choices) || !json.choices.length) return;
      const choice = object(json.choices[0]);
      if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;
      if (!choice.delta) return;
      const delta = object(choice.delta);
      if (typeof delta.content === 'string') {
        first ??= performance.now() - start;
        content += delta.content;
        options.onText?.(delta.content);
      }
      if (delta.tool_calls !== undefined && !Array.isArray(delta.tool_calls))
        throw new AxiomError('TOOL_PROTOCOL', 'Invalid tool_calls');
      for (const item of (delta.tool_calls ?? []) as unknown[]) {
        const call = object(item);
        const index = call.index;
        if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 31)
          throw new AxiomError('TOOL_PROTOCOL', 'Invalid tool call index');
        first ??= performance.now() - start;
        const current = calls.get(index) ?? {
          id: '',
          type: 'function' as const,
          function: { name: '', arguments: '' },
        };
        if (call.id !== undefined) {
          const id = string(call.id, 'tool id', 256);
          if (current.id && current.id !== id)
            throw new AxiomError('TOOL_PROTOCOL', 'Conflicting call id');
          current.id = id;
        }
        if (call.function) {
          const fn = object(call.function);
          if (fn.name !== undefined) current.function.name += string(fn.name, 'tool name', 128);
          if (fn.arguments !== undefined)
            current.function.arguments += string(fn.arguments, 'tool arguments', 600000);
          if (current.function.arguments.length > 600000 || current.function.name.length > 128)
            throw new AxiomError('TOOL_LIMIT', 'Tool call too large');
        }
        calls.set(index, current);
      }
    };
    try {
      while (!doneMarker) {
        signal.throwIfAborted();
        const next = await reader.read();
        if (next.done) break;
        received += next.value.byteLength;
        if (received > 4_000_000) throw new AxiomError('SSE_LIMIT', 'Response exceeds 4 MB');
        buffer += decoder.decode(next.value, { stream: true });
        let match: RegExpExecArray | null;
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          parseBlock(buffer.slice(0, match.index));
          buffer = buffer.slice(match.index + match[0].length);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim() && !doneMarker) parseBlock(buffer);
      if (!doneMarker && !finishReason)
        throw new AxiomError(
          'STREAM_INCOMPLETE',
          'Stream ended without a finish marker; no tool calls executed',
        );
      if (finishReason === 'length')
        throw new AxiomError(
          'TOKEN_LIMIT',
          'Completion hit token limit; partial tool calls will not execute',
        );
      const toolCalls = [...calls].sort(([a], [b]) => a - b).map(([, v]) => v);
      const ids = new Set<string>();
      for (const call of toolCalls) {
        if (!call.id || !call.function.name || ids.has(call.id))
          throw new AxiomError('TOOL_PROTOCOL', 'Missing or duplicate tool call identifier');
        ids.add(call.id);
      }
      const message: Message = {
        role: 'assistant',
        content: content || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      };
      return {
        content,
        toolCalls,
        message,
        usage,
        ttftMs: first,
        elapsedMs: performance.now() - start,
        finishReason,
      };
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
export class OpenAIBackend implements Backend {
  readonly client: LMStudioClient;
  constructor(
    readonly baseURL: string,
    readonly model: string,
    readonly maxTokens = 1024,
    readonly seed = 42,
    apiKey?: string,
  ) {
    this.client = new LMStudioClient(baseURL, apiKey);
  }
  async complete(
    messages: Message[],
    tools: ToolDefinition[],
    signal: AbortSignal,
    onText: (text: string) => void,
  ): Promise<Completion> {
    return this.client.chat({
      model: this.model,
      messages,
      tools,
      signal,
      onText,
      maxTokens: this.maxTokens,
      seed: this.seed,
    });
  }
}
