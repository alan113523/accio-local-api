import http from 'node:http';
import { readFile, mkdir, open, lstat } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AccioAuth, ApiError } from './auth.mjs';
import { AccioClient } from './accio.mjs';
import { convertRequest, Completion } from './protocol.mjs';

const installSettingsPath = new URL('../windows-install.json', import.meta.url);
const API_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const installedStateDirectory = process.platform === 'win32' && existsSync(installSettingsPath)
  ? JSON.parse(readFileSync(installSettingsPath, 'utf8')).stateDirectory : undefined;
export const STATE_DIR = process.env.ACCIO_API_STATE_DIR || installedStateDirectory || (process.platform === 'win32'
  ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData/Local'), 'Accio Local API')
  : join(homedir(), 'Library/Application Support/Accio Local API'));
export const PORT = Number(process.env.ACCIO_API_PORT || 18437);
export async function apiKey(directory = STATE_DIR) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'api.key');
  try {
    const file = await open(path, 'wx', 0o600);
    try { await file.writeFile('accio-local-' + randomBytes(32).toString('hex') + '\n'); }
    finally { await file.close(); }
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) {
    throw new Error('Local API key must be a private regular file owned by this user');
  }
  const key = (await readFile(path, 'utf8')).trim();
  if (!/^accio-local-[a-f0-9]{64}$/.test(key)) throw new Error('Invalid local API key file');
  return key;
}
function authenticated(req, key) {
  const value = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : req.headers['x-api-key'];
  return typeof value === 'string' && Buffer.byteLength(value) === Buffer.byteLength(key)
    && timingSafeEqual(Buffer.from(value), Buffer.from(key));
}
function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(value));
}
async function bodyJson(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new ApiError(415, 'content_type', 'Use application/json');
  let length = 0; const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 8 * 1024 * 1024) throw new ApiError(413, 'request_too_large', 'Request exceeds 8 MiB');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ApiError(400, 'invalid_json', 'Invalid JSON request'); }
}
function errorBody(error, protocol) {
  const code = error instanceof ApiError ? error.code : 'bridge_error';
  const message = error instanceof ApiError ? error.message : 'Local API request failed';
  return protocol === 'anthropic' ? { type: 'error', error: { type: code, message } }
    : { error: { message, type: code, code } };
}

export function createApi({ key, auth, client, timeoutMs = 120000, concurrency = 50 }) {
  const active = new Set();
  const server = http.createServer(async (req, res) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });
    let protocol = 'openai', reserved = false;
    try {
      const port = server.address()?.port;
      if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) throw new ApiError(403, 'invalid_host', 'Use the localhost API address');
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      protocol = url.pathname === '/v1/messages' ? 'anthropic' : 'openai';
      if (url.pathname === '/health' && req.method === 'GET') return json(res, 200, { status: 'running', version: API_VERSION });
      if (url.pathname === '/auth/callback' && req.method === 'GET') {
        let location = '/auth/error';
        try {
          if (url.searchParams.getAll('state').length !== 1 || url.searchParams.getAll('code').length !== 1) throw new ApiError(400, 'invalid_oauth_callback', 'Invalid OAuth callback');
          await auth.callback(url.searchParams.get('state'), url.searchParams.get('code'));
          client.catalog = null;
          location = '/auth/done';
        } catch { /* Drop OAuth query values from the browser address on failure too. */ }
        res.writeHead(303, { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
        return res.end();
      }
      if (['/auth/done', '/auth/error'].includes(url.pathname) && req.method === 'GET') {
        const success = url.pathname === '/auth/done';
        res.writeHead(success ? 200 : 400, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
        return res.end(success ? 'Accio Local API 登录完成。可以关闭此页面。\n' : 'Accio Local API 登录未完成。请重新运行 login 命令。\n');
      }
      if (req.headers.origin) throw new ApiError(403, 'browser_access_disabled', 'Browser-origin requests are disabled');
      if (!authenticated(req, key)) throw new ApiError(401, 'authentication_error', 'A valid local API key is required');
      if (req.method === 'POST' && url.pathname === '/auth/start') return json(res, 200, { url: auth.begin(`http://127.0.0.1:${port}`) });
      if (req.method === 'GET' && url.pathname === '/status') return json(res, 200, {
        authenticated: Boolean(auth.credentials), modelCount: client.catalog?.length ?? 0, addedSystemPromptChars: 0,
        upstream: 'phoenix-gw.alibaba.com', agentWorkflow: false, apis: ['/v1/chat/completions', '/v1/messages'],
        generationConcurrencyLimit: concurrency, activeGenerationRequests: active.size,
      });
      if (req.method === 'GET' && url.pathname === '/quota') return json(res, 200, await client.quota(controller.signal));
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        const models = await client.models(controller.signal);
        return json(res, 200, { object: 'list', data: models.map(m => ({ id: m.alias, object: 'model', created: 0,
          owned_by: 'accio', name: m.modelDisplayName, accio_model_id: m.modelCode,
          context_window: m.contextWindow, reasoning_efforts: m.reasoningEfforts,
          default_reasoning_effort: m.defaultReasoningEffort, usage_multiple: m.effectiveMultiple ?? m.usageMultiple })) });
      }
      if (url.pathname === '/v1/responses' || url.pathname === '/v1/messages/count_tokens') {
        throw new ApiError(501, 'unsupported_endpoint', 'This release supports Chat Completions and Messages; no exact token-count endpoint is available');
      }
      if (req.method !== 'POST' || !['/v1/chat/completions', '/v1/messages'].includes(url.pathname)) throw new ApiError(404, 'not_found', 'Unknown endpoint');
      if (active.size >= concurrency) throw new ApiError(429, 'local_capacity', `Local API generation concurrency limit (${concurrency}) reached`);
      active.add(controller); reserved = true;
      const body = await bodyJson(req);
      const model = await client.resolve(body?.model, controller.signal);
      const request = convertRequest(body, protocol, model);
      const completion = new Completion(model);
      res.setHeader('x-accio-model-id', model.modelCode);
      res.setHeader('x-accio-added-system-prompt-chars', '0');
      if (body.stream !== true) {
        for await (const frame of client.generate(request, controller.signal)) completion.apply(frame);
        completion.validate();
        return json(res, 200, protocol === 'openai' ? completion.openai() : completion.anthropic());
      }
      let started = false, nextBlock = 0, textBlock = null;
      const send = async (event, data) => {
        if (!started) { res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' }); started = true; }
        const chunk = (event ? `event: ${event}\n` : '') + `data: ${JSON.stringify(data)}\n\n`;
        if (!res.write(chunk)) await once(res, 'drain', { signal: controller.signal });
      };
      const openaiChunk = (delta, finish = null, extra = {}) => ({ id: completion.id, object: 'chat.completion.chunk', created: completion.created,
        model: completion.model, choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }], ...extra });
      for await (const frame of client.generate(request, controller.signal)) {
        if (!started) {
          if (protocol === 'openai') await send(null, openaiChunk({ role: 'assistant', content: '' }));
          else await send('message_start', { type: 'message_start', message: { id: completion.id.replace('chatcmpl_', 'msg_'), type: 'message', role: 'assistant', model: completion.model,
            content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
        }
        for (const event of completion.apply(frame)) {
          if (protocol === 'openai') {
            await send(null, openaiChunk(event.type === 'text' ? { content: event.text }
              : { tool_calls: [{ index: event.index, ...event.tool }] }));
          } else if (event.type === 'text') {
            if (textBlock === null) { textBlock = nextBlock++; await send('content_block_start', { type: 'content_block_start', index: textBlock, content_block: { type: 'text', text: '' } }); }
            await send('content_block_delta', { type: 'content_block_delta', index: textBlock, delta: { type: 'text_delta', text: event.text } });
          } else {
            if (textBlock !== null) { await send('content_block_stop', { type: 'content_block_stop', index: textBlock }); textBlock = null; }
            const index = nextBlock++;
            await send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: event.tool.id, name: event.tool.function.name, input: {} } });
            await send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: event.tool.function.arguments } });
            await send('content_block_stop', { type: 'content_block_stop', index });
          }
        }
      }
      completion.validate();
      if (protocol === 'openai') {
        await send(null, openaiChunk({}, completion.finish));
        if (body.stream_options?.include_usage && completion.usage) await send(null, { ...openaiChunk({}), choices: [], usage: completion.usage });
        res.end('data: [DONE]\n\n');
      } else {
        if (textBlock !== null) await send('content_block_stop', { type: 'content_block_stop', index: textBlock });
        const result = completion.anthropic();
        await send('message_delta', { type: 'message_delta', delta: { stop_reason: result.stop_reason, stop_sequence: null }, usage: result.usage });
        await send('message_stop', { type: 'message_stop' }); res.end();
      }
    } catch (error) {
      const effective = controller.signal.aborted ? new ApiError(504, 'request_timeout', 'Request timed out or was cancelled') : error;
      controller.abort();
      if (!res.destroyed) {
        if (!res.headersSent) json(res, effective.status || 500, errorBody(effective, protocol));
        else res.end((protocol === 'anthropic' ? 'event: error\n' : '') + 'data: ' + JSON.stringify(errorBody(effective, protocol)) + '\n\n');
      }
    } finally { clearTimeout(timer); if (reserved) active.delete(controller); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  server.on('close', () => { for (const controller of active) controller.abort(); });
  return server;
}

export async function main() {
  if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) throw new Error('Invalid ACCIO_API_PORT');
  const key = await apiKey();
  if (process.platform === 'win32') process.env.ACCIO_API_STATE_DIR = STATE_DIR;
  const auth = new AccioAuth(); await auth.init();
  const server = createApi({ key, auth, client: new AccioClient(auth) });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, '127.0.0.1', resolve); });
  console.log(`Accio Local API ${API_VERSION} listening on http://127.0.0.1:${PORT}`);
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { server.close(); server.closeAllConnections(); setTimeout(() => process.exit(0), 100).unref(); });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error instanceof ApiError ? error.message : 'Accio Local API startup failed'); process.exitCode = 1; });
