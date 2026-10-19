const REQUEST_TIMEOUT = 180_000;

export class LMStudioClient {
  constructor(baseUrl, apiKey = process.env.PILOTCODE_API_KEY) {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP(S) endpoints are supported.');
    this.baseUrl = url.toString().replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  async request(path, options = {}) {
    let response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...options,
        signal: options.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT),
        headers: {
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...options.headers,
        },
      });
    } catch (error) {
      if (options.signal?.aborted || error.name === 'AbortError') throw new Error('Request interrupted.');
      throw new Error(`Cannot connect to LM Studio at ${this.baseUrl}. Start the Local Server. (${error.message})`);
    }
    if (!response.ok) {
      const body = (await response.text()).slice(0, 800);
      throw new Error(`LM Studio HTTP ${response.status}: ${body || response.statusText}`);
    }
    return response;
  }

  async models() {
    const data = await (await this.request('/models')).json();
    if (!Array.isArray(data.data)) throw new Error('Unexpected /models response from backend.');
    return data.data.map(m => m.id).filter(x => typeof x === 'string' && x.length > 0);
  }

  async chat({ model, messages, tools = [], onText = () => {}, signal }) {
    const body = { model, messages, temperature: 0.2, stream: true };
    if (tools.length) { body.tools = tools; body.tool_choice = 'auto'; }
    const response = await this.request('/chat/completions', { method: 'POST', body: JSON.stringify(body), signal });
    if (!response.body) throw new Error('LM Studio returned no stream.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const calls = new Map();
    let content = '';
    let buffer = '';
    let ended = false;

    const parseBlock = block => {
      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') { ended = true; continue; }
        if (!payload) continue;
        let json;
        try { json = JSON.parse(payload); }
        catch { throw new Error('Malformed streaming response from LM Studio.'); }
        if (json.error) throw new Error(`LM Studio: ${JSON.stringify(json.error)}`);
        const delta = json.choices?.[0]?.delta;
        if (!delta) continue;
        if (typeof delta.content === 'string') {
          content += delta.content;
          onText(delta.content);
        }
        for (const call of delta.tool_calls || []) {
          const index = call.index ?? 0;
          const existing = calls.get(index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (call.id) existing.id = call.id;
          if (call.function?.name) existing.function.name += call.function.name;
          if (call.function?.arguments) existing.function.arguments += call.function.arguments;
          calls.set(index, existing);
        }
      }
    };

    try {
      while (!ended) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = buffer.replace(/\r\n/g, '\n');
        let index;
        while ((index = buffer.indexOf('\n\n')) !== -1) {
          parseBlock(buffer.slice(0, index));
          buffer = buffer.slice(index + 2);
        }
      }
      if (buffer.trim()) parseBlock(buffer);
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    return { content, toolCalls: [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value) };
  }
}
