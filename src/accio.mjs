import { createHash, randomUUID } from 'node:crypto';
import { APP_VERSION, APP_KEY, GATEWAY, ApiError, upstreamJson } from './auth.mjs';
import { nativeHeaders } from './signing.mjs';

export function modelAlias(model) {
  return model.modelDisplayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export class AccioClient {
  constructor(auth, fetchImpl = fetch, sign = nativeHeaders) { this.auth = auth; this.fetch = fetchImpl; this.sign = sign; this.catalog = null; this.catalogAt = 0; this.catalogContext = null; }
  metadata(operation) {
    return this.auth.withToken ? this.auth.withToken(operation) : this.auth.token().then(operation);
  }
  async models(signal) {
    const context = await this.auth.context?.(signal), contextKey = JSON.stringify(context ?? null);
    const routeHeaders = this.auth.headers?.();
    if (this.catalog && this.catalogContext === contextKey && Date.now() - this.catalogAt < 60000) return this.catalog;
    const config = await this.metadata(token => upstreamJson('/api/llm/config/v2', { method: 'POST', headers: routeHeaders, body: JSON.stringify({ token, supportAutoModel: false }), signal }, this.fetch));
    const providers = config.providers || (Array.isArray(config) ? config : config.data);
    if (!Array.isArray(providers)) throw new ApiError(502, 'invalid_model_catalog', 'Accio returned no model catalog');
    const models = providers.flatMap(p => (p.modelList || []).filter(m => m.modelCode && m.modelCode !== 'auto' && m.visible !== false && !m.locked)
      .map(m => ({ ...m, provider: p.provider, alias: modelAlias(m) })));
    if (!models.length) throw new ApiError(502, 'empty_model_catalog', 'Accio returned no available models');
    this.catalog = models; this.catalogAt = Date.now(); this.catalogContext = contextKey; return models;
  }
  async resolve(name, signal) {
    if (typeof name !== 'string' || !name.trim()) throw new ApiError(400, 'model_required', 'model is required');
    const models = await this.models(signal);
    const model = models.find(m => [m.modelCode, m.modelName, m.modelDisplayName, m.alias].some(v => v?.toLowerCase() === name.toLowerCase()));
    if (!model) throw new ApiError(400, 'model_not_available', 'Requested model is absent from the live Accio catalog');
    return model;
  }
  async quota(signal) {
    const context = await this.auth.context?.(signal), routeHeaders = this.auth.headers?.();
    const data = await this.metadata(token => {
      const url = new URL('/api/entitlement/currentSubscription', GATEWAY);
      url.searchParams.set('accessToken', token);
      url.searchParams.set('subscripType', context?.teamId ? 'TEAM' : 'INDIVIDUAL');
      if (context?.teamId) url.searchParams.set('teamId', context.teamId);
      return upstreamJson(url.pathname + url.search, { signal, headers: routeHeaders }, this.fetch);
    });
    if (context?.teamId && data.type !== 'TEAM') throw new ApiError(502, 'quota_scope_mismatch', 'Accio did not return the selected team subscription');
    const total = Number(data.total), remaining = Number(data.remaining);
    if (data.total == null || data.remaining == null || !Number.isFinite(total) || !Number.isFinite(remaining) || total < 0 || remaining < 0) {
      throw new ApiError(502, 'quota_unavailable', 'Accio returned no usable credit counters');
    }
    const used = Math.max(0, total - remaining);
    return { scope: context?.teamId ? 'team' : 'personal', planType: data.type ?? null,
      totalCredits: total, usedCredits: used, remainingCredits: remaining,
      usagePercent: total > 0 ? used / total * 100 : null };
  }
  async *generate(request, signal) {
    await this.auth.context?.(signal);
    const routeHeaders = this.auth.headers?.();
    const token = await this.auth.token();
    const body = { ...request, token, request_id: randomUUID(), message_id: randomUUID(),
      iai_tag: 'phoenix-desktop', auto_model: false, properties: { normalized_response: 'true' } };
    const requestKey = createHash('md5').update(body.request_id, 'utf8').digest('hex');
    const url = `${GATEWAY}/api/adk/llm/generateContent?sg_k=${requestKey}`;
    const signedHeaders = await this.sign(url, signal, this.auth.credentials?.sgcookie);
    const response = await this.fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream',
        version: APP_VERSION, appKey: APP_KEY, 'x-app-version': APP_VERSION, 'x-os': process.platform, 'x-language': 'zh',
        ...routeHeaders, ...signedHeaders },
      body: JSON.stringify(body), signal, redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ApiError(response.status === 429 ? 429 : 502, 'accio_http_error', `Accio model gateway returned HTTP ${response.status}`);
    }
    if (!response.body) throw new ApiError(502, 'empty_upstream', 'Accio returned an empty stream');
    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      const contentType = response.headers.get('content-type') || '';
      await response.body.cancel();
      throw new ApiError(502, 'accio_non_model_response', contentType.includes('text/html')
        ? 'Accio returned an HTML gateway page instead of model events' : 'Accio returned a non-stream response');
    }
    let terminal = false;
    for await (const event of parseSse(response.body)) {
      let frame;
      try { frame = JSON.parse(event.data); }
      catch { throw new ApiError(502, 'invalid_upstream_stream', 'Accio returned invalid SSE JSON'); }
      if (frame.error_code || frame.error_message || frame.error) {
        const code = String(frame.error_code || frame.error?.code || 'upstream_error');
        throw new ApiError(code === '429' ? 429 : 502, 'accio_inference_error', `Accio inference failed (${/^[a-zA-Z0-9_-]{1,64}$/.test(code) ? code : 'upstream_error'})`);
      }
      if (frame.turn_complete || frame.finish_reason) terminal = true;
      yield frame;
    }
    if (!terminal) throw new ApiError(502, 'incomplete_upstream_stream', 'Accio closed the stream before completion');
  }
}

export async function* parseSse(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
        if (Buffer.byteLength(block) > 4 * 1024 * 1024) throw new ApiError(502, 'upstream_frame_too_large', 'Accio SSE frame exceeds 4 MiB');
        const lines = block.split(/\r?\n/);
        const data = lines.filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
        if (data && data !== '[DONE]') yield { event: lines.find(l => l.startsWith('event:'))?.slice(6).trim(), data };
      }
      if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) throw new ApiError(502, 'upstream_frame_too_large', 'Accio SSE frame exceeds 4 MiB');
      if (done) {
        if (buffer.trim() && !buffer.trim().startsWith(':')) throw new ApiError(502, 'incomplete_upstream_stream', 'Accio returned an incomplete SSE frame');
        break;
      }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
