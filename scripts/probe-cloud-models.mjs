import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { AccioAuth } from '../src/auth.mjs';
import { AccioClient } from '../src/accio.mjs';
import { convertRequest } from '../src/protocol.mjs';

// Inspect only this process's synthetic requests, using the bridge's own grant.
// Save schema, model claims and numeric usage; never save raw payloads or headers.
const rawCatalogMode = process.argv.includes('--raw-catalog');
const outputDirectory = new URL('../probe-results/', import.meta.url);
await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
const output = new URL(rawCatalogMode ? 'cloud-model-catalog.json' : 'cloud-format-comparison.json', outputDirectory);
const auth = new AccioAuth();
await auth.init();
const report = { startedAt: new Date().toISOString(), runtimeConfigurationChanged: false,
  prompt: 'Compute 17*23. Reply only the integer.', maxOutputTokens: 64, probes: [],
  cloudVendorIdentityIndependentlyVerified: false };
async function save() {
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  await chmod(output, 0o600);
}
const variants = rawCatalogMode ? (await new AccioClient(auth).models()).filter(m => m.alias.startsWith('claude-')).map(m => ({ alias: m.alias, normalized: 'false' })) : [
  { alias: 'claude-sonnet-5', normalized: 'true' },
  { alias: 'claude-haiku-5-5', normalized: 'true' },
  { alias: 'claude-opus-5-5', normalized: 'false' },
];
for (const variant of variants) {
  const probe = { ...variant, startedAt: new Date().toISOString(), modelClaims: [], eventTypes: [], frameKeys: [],
    headerAnalysis: {}, bedrockMetrics: [], gatewayErrors: [], visibleReply: '', frameCount: 0 };
  const modelClaims = new Set(), eventTypes = new Set(), frameKeys = new Set();
  function walk(value, path = '$', depth = 0) {
    if (value == null || depth > 14) return;
    if (typeof value === 'string' && /^\s*[\[{]/.test(value) && value.length < 1048576) {
      try { walk(JSON.parse(value), path + '<json>', depth + 1); } catch {}
      return;
    }
    if (Array.isArray(value)) { for (const item of value.slice(0, 100)) walk(item, path + '[]', depth + 1); return; }
    if (typeof value !== 'object') return;
    if (value['amazon-bedrock-invocationMetrics']) {
      const metrics = value['amazon-bedrock-invocationMetrics'];
      probe.bedrockMetrics.push(Object.fromEntries(['inputTokenCount', 'outputTokenCount', 'invocationLatency', 'firstByteLatency']
        .filter(k => Number.isFinite(metrics[k])).map(k => [k, metrics[k]])));
    }
    for (const [k, v] of Object.entries(value)) {
      frameKeys.add(k);
      if (k === 'type' && typeof v === 'string' && /^[a-z_]{1,64}$/.test(v)) eventTypes.add(v);
      if (/^(?:model|model_name|modelName|model_id|modelId|model_version|modelVersion|provider|provider_name|providerName)$/.test(k)
        && typeof v === 'string' && /^(?:claude[\w. -]*|anthropic[\w. -]*|1Orbit[\w-]*|openai|google|deepseek)$/i.test(v)) {
        modelClaims.add(JSON.stringify({ path: path + '.' + k, value: v }));
      }
      walk(v, path + '.' + k, depth + 1);
    }
  }
  const observe = async (url, init) => {
    if (new URL(url).pathname !== '/api/adk/llm/generateContent') return fetch(url, init);
    const body = JSON.parse(init.body);
    body.properties.normalized_response = variant.normalized;
    const response = await fetch(url, { ...init, body: JSON.stringify(body) });
    probe.httpStatus = response.status;
    probe.contentType = response.headers.get('content-type');
    probe.requestedAccioModelId = body.model;
    probe.autoModel = body.auto_model;
    for (const name of ['x-aigc-metadata', 'ups-target-key', 'x-protocol']) {
      const value = response.headers.get(name);
      if (value == null) continue;
      let parsed;
      try { parsed = JSON.parse(value); } catch {}
      probe.headerAnalysis[name] = { present: true, length: value.length,
        jsonKeys: parsed && typeof parsed === 'object' ? Object.keys(parsed) : [],
        modelTokens: [...new Set(value.match(/\b(?:anthropic[.:/_-])?claude[-._a-zA-Z0-9:]+/g) ?? [])] };
      if (parsed) walk(parsed, '$headers.' + name);
    }
    const text = await response.text();
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') continue;
      let frame;
      try { frame = JSON.parse(data); } catch { probe.nonJsonEvents = (probe.nonJsonEvents ?? 0) + 1; continue; }
      probe.frameCount++;
      walk(frame);
      if (frame.error_code || frame.error) probe.gatewayErrors.push(String(frame.error_code ?? frame.error?.code ?? 'error').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64));
      if (frame.content?.parts) probe.visibleReply += frame.content.parts.filter(p => p.thought !== true && typeof p.text === 'string').map(p => p.text).join('');
      else {
        let vendor = frame;
        try { vendor = JSON.parse(frame.raw_response_json ?? frame.rawResponseJson); } catch {}
        if (vendor.type === 'content_block_delta' && vendor.delta?.type === 'text_delta') probe.visibleReply += vendor.delta.text ?? '';
        if (vendor.type === 'message_start' && vendor.message?.usage) {
          probe.vendorUsage = { input_tokens: vendor.message.usage.input_tokens, output_tokens: vendor.message.usage.output_tokens };
        }
        if (vendor.type === 'message_delta' && Number.isFinite(vendor.usage?.output_tokens)) {
          probe.vendorUsage = { ...probe.vendorUsage, output_tokens: vendor.usage.output_tokens };
        }
        if (vendor.type === 'message_delta' && typeof vendor.delta?.stop_reason === 'string') probe.vendorStopReason = vendor.delta.stop_reason;
      }
    }
    return new Response(text, { status: response.status, headers: response.headers });
  };
  try {
    const client = new AccioClient(auth, observe);
    const quota = await client.quota();
    if (quota.scope !== 'team' || quota.remainingCredits <= 0) throw new Error('Expected funded team space');
    const model = await client.resolve(variant.alias);
    const request = convertRequest({ model: variant.alias, reasoning_effort: 'low', max_tokens: 64,
      messages: [{ role: 'user', content: report.prompt }] }, 'openai', model);
    for await (const frame of client.generate(request, AbortSignal.timeout(120000))) {
      if (frame.usage_metadata) probe.normalizedUsage = frame.usage_metadata;
    }
    probe.normalizedClientCompleted = true;
  } catch (error) { probe.normalizedClientCompleted = false; probe.clientError = { name: error.name, code: error.code ?? null }; }
  probe.modelClaims = [...modelClaims].map(s => JSON.parse(s));
  probe.eventTypes = [...eventTypes].sort(); probe.frameKeys = [...frameKeys].sort();
  probe.visibleReplyCorrect = probe.visibleReply.trim() === '391';
  probe.vendorDeclaredModelExactlyMatches = probe.modelClaims.some(c => c.path.includes('message.model') && c.value === variant.alias);
  // Anthropic documents this legacy alias as the dated Haiku 4.5 snapshot.
  const documentedSnapshot = variant.alias === 'claude-haiku-4-5' ? 'claude-haiku-4-5-20251001' : null;
  probe.vendorDeclaredModelMatchesRequestedModel = probe.vendorDeclaredModelExactlyMatches ||
    (documentedSnapshot !== null && probe.modelClaims.some(c => c.path.includes('message.model') && c.value === documentedSnapshot));
  report.probes.push(probe);
  await save();
  console.log(JSON.stringify({ alias: probe.alias, normalized: probe.normalized, httpStatus: probe.httpStatus,
    visibleReplyCorrect: probe.visibleReplyCorrect, vendorDeclaredModelMatchesRequestedModel: probe.vendorDeclaredModelMatchesRequestedModel, modelClaims: probe.modelClaims, bedrockMetrics: probe.bedrockMetrics,
    eventTypes: probe.eventTypes, clientError: probe.clientError }));
}
report.completedAt = new Date().toISOString();
await save();
