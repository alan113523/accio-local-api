// Explicit, small, paid/quota-using smoke test. Never part of npm test.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { STATE_DIR, PORT } from '../src/server.mjs';
import { parseSse } from '../src/accio.mjs';

const key = (await readFile(join(STATE_DIR, 'api.key'), 'utf8')).trim();
const origin = `http://127.0.0.1:${PORT}`;
const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
const report = { time: new Date().toISOString(), api: origin + '/v1', authenticatedVia: 'independent Accio PKCE',
  upstream: 'phoenix-gw.alibaba.com', suppliedSystemPromptChars: 0, addedAgentPromptChars: 0, suppliedTools: 0, success: false };
const start = performance.now();
try {
  const modelsResponse = await fetch(origin + '/v1/models', { headers, signal: AbortSignal.timeout(30000) });
  const models = await modelsResponse.json();
  const model = models.data?.find(m => m.id === 'claude-opus-5-5');
  if (!modelsResponse.ok || !model) throw new Error('Opus 5.5 is absent from the authenticated live Accio catalog');
  report.model = model;
  const requestStart = performance.now();
  const response = await fetch(origin + '/v1/chat/completions', { method: 'POST', headers,
    body: JSON.stringify({ model: model.id, messages: [{ role: 'user', content: '不要调用任何工具，只回复：Accio直连成功' }],
      stream: true, stream_options: { include_usage: true }, reasoning_effort: 'low', max_tokens: 128 }), signal: AbortSignal.timeout(125000) });
  report.httpStatus = response.status;
  report.resolvedAccioId = response.headers.get('x-accio-model-id');
  report.headerAddedPromptChars = response.headers.get('x-accio-added-system-prompt-chars');
  if (!response.ok) { const error = await response.json(); throw new Error(error.error?.message || `HTTP ${response.status}`); }
  let reply = '', finished = false, chunks = 0;
  for await (const event of parseSse(response.body)) {
    const data = JSON.parse(event.data); chunks++;
    if (data.error) throw new Error(data.error.message);
    for (const choice of data.choices || []) {
      if (choice.delta?.content) { report.firstTextMs ??= Math.round(performance.now() - requestStart); reply += choice.delta.content; }
      if (choice.finish_reason) { finished = true; report.finishReason = choice.finish_reason; }
    }
    if (data.usage) report.usage = data.usage;
  }
  report.reply = reply; report.chunks = chunks;
  report.requestTotalMs = Math.round(performance.now() - requestStart);
  report.success = finished && reply.includes('Accio直连成功') && report.resolvedAccioId === model.accio_model_id;
} catch (error) { report.error = error.message; }
report.totalMs = Math.round(performance.now() - start);
if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.success ? 0 : 1;
