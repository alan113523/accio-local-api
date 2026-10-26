import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { AccioAuth, ApiError } from '../src/auth.mjs';
import { AccioClient, parseSse } from '../src/accio.mjs';
import { convertRequest, Completion } from '../src/protocol.mjs';
import { createApi } from '../src/server.mjs';

const model = { modelCode: '1Orbit-Q55pN8xR6cP2m', modelDisplayName: 'Claude Opus 5.5', alias: 'claude-opus-5-5',
  reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoningEffort: 'medium' };
const frame = text => ({ content: { parts: [{ text, thought: false }] } });
const last = { turn_complete: true, finish_reason: 'STOP', usage_metadata: { prompt_token_count: 8, candidates_token_count: 3, total_token_count: 11 } };
const key = 'test-private-api-key';
function stream(text, widths = [3, 5, 1, 9]) {
  const bytes = new TextEncoder().encode(text); let offset = 0, i = 0;
  return new ReadableStream({ pull(controller) { if (offset >= bytes.length) return controller.close(); const end = Math.min(bytes.length, offset + widths[i++ % widths.length]); controller.enqueue(bytes.slice(offset, end)); offset = end; } });
}
const base = { model: model.alias, messages: [{ role: 'user', content: '你好' }], max_tokens: 128 };

test('PKCE binds the callback to a fresh verifier, fixed client, and loopback return', async () => {
  let stored, exchanges = 0;
  const auth = new AccioAuth({ store: { read: async () => null, write: async v => { stored = v; } }, fetchImpl: async (url, options) => {
    exchanges++;
    assert.equal(url.href, 'https://phoenix-gw.alibaba.com/api/oauth/token');
    const body = JSON.parse(options.body);
    assert.equal(body.clientId, 'accio-work'); assert.equal(body.code, 'one-time-code');
    assert.equal(body.redirectUri, 'http://127.0.0.1:18437/auth/callback');
    assert.equal(createHash('sha256').update(body.codeVerifier).digest('base64url'), login.searchParams.get('code_challenge'));
    return Response.json({ success: true, data: { accessToken: 'own-new-grant', refreshToken: 'own-refresh', expiresAt: Date.now() / 1000 + 1000 } });
  } });
  const login = new URL(auth.begin('http://127.0.0.1:18437'));
  assert.equal(login.origin, 'https://www.accio.com'); assert.equal(login.searchParams.get('code_challenge_method'), 'S256');
  await assert.rejects(auth.callback('forged', 'code'), /Invalid/); assert.equal(exchanges, 0);
  await auth.callback(login.searchParams.get('state'), 'one-time-code');
  assert.equal(stored.accessToken, 'own-new-grant');
  await assert.rejects(auth.callback(login.searchParams.get('state'), 'one-time-code'), /Invalid/);
  assert.equal(exchanges, 1);
});
test('expired OAuth state never triggers token exchange', async () => {
  let now = 0;
  const auth = new AccioAuth({ now: () => now, store: {}, fetchImpl: () => assert.fail('must not fetch') });
  const state = new URL(auth.begin('http://127.0.0.1:18437')).searchParams.get('state'); now = 600001;
  await assert.rejects(auth.callback(state, 'code'), /expired/);
});
test('concurrent refreshes use one exchange and store only the bridge grant', async () => {
  let count = 0, saved;
  const auth = new AccioAuth({ store: { write: async value => { saved = value; } }, fetchImpl: async (url, options) => {
    count++; assert.equal(url.pathname, '/api/auth/refresh_token'); assert.equal(JSON.parse(options.body).refreshToken, 'old-refresh');
    return Response.json({ success: true, data: { accessToken: 'new', refreshToken: 'new-refresh', expiresAt: Date.now() / 1000 + 3600 } });
  } });
  auth.credentials = { accessToken: 'old', refreshToken: 'old-refresh', expiresAt: 1, sgcookie: 'own-signing-cookie' };
  assert.deepEqual(await Promise.all([auth.token(), auth.token()]), ['new', 'new']);
  assert.equal(count, 1); assert.equal(saved.refreshToken, 'new-refresh');
  assert.equal(saved.sgcookie, 'own-signing-cookie');
});
test('a new login clears previous account routing and signing context', async () => {
  let saved;
  const auth = new AccioAuth({ store: { write: async value => { saved = value; } }, fetchImpl: async () => Response.json({
    data: { accessToken: 'next-account', refreshToken: 'next-refresh', expiresAt: Date.now() / 1000 + 3600 },
  }) });
  auth.credentials = { sgcookie: 'previous-account-cookie' };
  auth.contextData = { routeRegion: 'old', teamId: 'old-team' };
  const login = new URL(auth.begin('http://127.0.0.1:18437'));
  await auth.callback(login.searchParams.get('state'), 'fresh-code');
  assert.equal(saved.sgcookie, undefined); assert.equal(auth.contextData, null);
});
test('logged-out requests fail closed', async () => { await assert.rejects(new AccioAuth({ store: {} }).token(), /login command/); });
test('routing follows the official selected space even when userinfo has no activeTeam', async () => {
  let space = { kind: 'team', accountId: 'own-account', teamId: 'own-team' }, calls = 0;
  const auth = new AccioAuth({ readSpace: async () => space, fetchImpl: async () => {
    calls++; return Response.json({ data: { userId: 'own-account', routeRegion: 'CN', activeTeam: null } });
  } });
  auth.credentials = { accessToken: 'own-token', expiresAt: Date.now() + 3600000 };
  await auth.context(); assert.equal(auth.headers()['x-team-id'], 'own-team');
  await auth.context(); assert.equal(calls, 1);
  space = { ...space, teamId: 'another-own-team' };
  await auth.context(); assert.equal(auth.headers()['x-team-id'], 'another-own-team');
  space = { kind: 'personal', accountId: 'own-account' };
  await auth.context(); assert.equal(auth.headers()['x-team-id'], undefined);
});
test('a different official account or unavailable space cannot silently use a personal pool', async () => {
  for (const space of [{ kind: 'team', accountId: 'different-account', teamId: 'unrelated-team' }, null]) {
    const auth = new AccioAuth({ readSpace: async () => space, fetchImpl: async () => Response.json({
      data: { userId: 'own-account', routeRegion: 'CN', activeTeam: null },
    }) });
    auth.credentials = { accessToken: 'own-token', expiresAt: Date.now() + 3600000 };
    await assert.rejects(auth.context(), ApiError);
    assert.equal(auth.headers()['x-team-id'], undefined);
  }
});

test('text conversion adds no system instructions or tools', () => {
  const result = convertRequest(base, 'openai', model);
  assert.equal(result.model, model.modelCode); assert.equal(result.system_instruction, undefined);
  assert.equal(result.tools, undefined); assert.equal(result.reasoning_effort, 'medium');
  assert.deepEqual(result.contents, [{ role: 'user', parts: [{ text: '你好', thought: false }] }]);
});
test('client system messages pass through unchanged', () => {
  const result = convertRequest({ ...base, messages: [{ role: 'system', content: '只答一句。' }, ...base.messages], reasoning_effort: 'low' }, 'openai', model);
  assert.equal(result.system_instruction, '只答一句。'); assert.equal(result.reasoning_effort, 'low');
});
test('Anthropic adaptive thinking uses the requested Accio effort without adding identity instructions', () => {
  const result = convertRequest({ ...base, thinking: { type: 'adaptive' }, output_config: { effort: 'high' } }, 'anthropic', model);
  assert.equal(result.reasoning_effort, 'high'); assert.equal(result.include_thoughts, false);
  assert.equal(result.model, model.modelCode); assert.equal(result.system_instruction, undefined);
  const defaults = convertRequest({ ...base, thinking: { type: 'adaptive' } }, 'anthropic', model);
  assert.equal(defaults.reasoning_effort, 'medium');
});
test('Anthropic thinking budgets and unrecognized thinking options remain unsupported', () => {
  for (const thinking of [{ type: 'enabled', budget_tokens: 1024 }, { type: 'adaptive', budget_tokens: 1024 }, { type: 'unknown' }]) {
    assert.throws(() => convertRequest({ ...base, thinking }, 'anthropic', model), ApiError);
  }
});
test('Claude Desktop system-role messages join Anthropic system instructions unchanged', () => {
  const result = convertRequest({ ...base, system: 'Client instructions.', messages: [
    { role: 'system', content: [{ type: 'text', text: 'You are powered by the model named Opus 5.5.' }] }, ...base.messages,
  ] }, 'anthropic', model);
  assert.equal(result.system_instruction, 'Client instructions.\n\nYou are powered by the model named Opus 5.5.');
  assert.deepEqual(result.contents, [{ role: 'user', parts: [{ text: '你好', thought: false }] }]);
});
test('function schema keys, tool inputs, and matching results survive conversion', () => {
  const request = convertRequest({ ...base, tools: [{ type: 'function', function: { name: 'echo', parameters: { type: 'object', properties: { camelCase: { type: 'string' } } } } }], messages: [
    ...base.messages, { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'echo', arguments: '{"camelCase":"ok"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: '{"camelCase":"ok"}' },
  ] }, 'openai', model);
  assert.match(request.tools[0].parameters_json, /camelCase/);
  assert.equal(request.contents[1].parts[0].function_call.args_json, '{"camelCase":"ok"}');
  assert.deepEqual(request.contents[2].parts[0].function_response, { id: 'call_1', name: 'echo', response_json: '{"camelCase":"ok"}' });
});
test('Anthropic text and tool round trip preserves the input schema', () => {
  const result = convertRequest({ ...base, system: [{ type: 'text', text: '简短。' }], tools: [{ name: 'echo', input_schema: { type: 'object', properties: { x: { type: 'number' } } } }], messages: [
    ...base.messages, { role: 'assistant', content: [{ type: 'tool_use', id: 'call_a', name: 'echo', input: { x: 2 } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_a', content: '2' }] },
  ] }, 'anthropic', model);
  assert.equal(result.system_instruction, '简短。'); assert.equal(result.contents[2].parts[0].function_response.name, 'echo');
});
for (const [label, change] of [
  ['unsupported image', { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'file:///secret' } }] }] }],
  ['invalid max tokens', { max_tokens: -1 }], ['multiple candidates', { n: 2 }], ['unsupported effort', { reasoning_effort: 'ultra' }],
  ['forced tool choice', { tool_choice: 'required' }], ['orphan tool response', { messages: [{ role: 'tool', tool_call_id: 'no_match', content: 'x' }] }],
  ['extended thinking', { thinking: { type: 'adaptive' } }],
]) test(label + ' fails explicitly', () => assert.throws(() => convertRequest({ ...base, ...change }, 'openai', model), ApiError));

test('SSE parser handles fragmented Unicode, CRLF, comments, and DONE', async () => {
  const events = [];
  for await (const event of parseSse(stream(': ping\r\n\r\ndata: {"text":"成功"}\r\n\r\ndata: [DONE]\r\n\r\n'))) events.push(event);
  assert.equal(events.length, 1); assert.equal(JSON.parse(events[0].data).text, '成功');
});
test('SSE truncation is an error', async () => { await assert.rejects(async () => { for await (const _ of parseSse(stream('data: {"broken":true}'))) {} }, /incomplete/); });
test('Accio client sends only the selected native ID and the bridge OAuth token', async () => {
  let sent;
  const client = new AccioClient({ token: async () => 'bridge-own-token' }, async (url, options) => {
    assert.match(url, /^https:\/\/phoenix-gw\.alibaba\.com\/api\/adk\/llm\/generateContent/);
    assert.equal(options.redirect, 'error'); sent = JSON.parse(options.body);
    assert.equal(new URL(url).searchParams.get('sg_k'), createHash('md5').update(sent.request_id).digest('hex'));
    return new Response(stream('data: ' + JSON.stringify(last) + '\n\n'), { headers: { 'content-type': 'text/event-stream' } });
  }, async () => ({ 'test-signature': 'signed' }));
  for await (const _ of client.generate(convertRequest(base, 'openai', model), new AbortController().signal)) {}
  assert.equal(sent.model, model.modelCode); assert.equal(sent.token, 'bridge-own-token');
  assert.equal(sent.system_instruction, undefined); assert.equal(sent.auto_model, false);
});
test('upstream errors never expose response bodies or try a different provider', async () => {
  let count = 0;
  const client = new AccioClient({ token: async () => 'secret' }, async () => { count++; return new Response('secret raw body', { status: 403 }); }, async () => ({}));
  await assert.rejects(async () => { for await (const _ of client.generate({}, new AbortController().signal)) {} }, error => !error.message.includes('secret') && error.message.includes('403'));
  assert.equal(count, 1);
});
test('HTML gateway responses are rejected before SSE parsing', async () => {
  const client = new AccioClient({ token: async () => 'secret' }, async () => new Response('<html>private diagnostics</html>', { headers: { 'content-type': 'text/html' } }), async () => ({}));
  await assert.rejects(async () => { for await (const _ of client.generate({}, new AbortController().signal)) {} }, error => error.code === 'accio_non_model_response' && !error.message.includes('private'));
});
test('only visible unlocked catalog models are advertised and aliases resolve exactly', async () => {
  const client = new AccioClient({ token: async () => 'secret' }, async () => Response.json({ data: { providers: [{ provider: 'claude', modelList: [model, { ...model, modelCode: 'hidden', visible: false }, { ...model, modelCode: 'locked', locked: true }] }] } }));
  assert.equal((await client.models()).length, 1); assert.equal((await client.resolve('claude-opus-5-5')).modelCode, model.modelCode);
  await assert.rejects(client.resolve('claude-opus-imaginary'), /absent/);
});
test('quota reads the selected subscription instead of the legacy daily percentage', async () => {
  const client = new AccioClient({ token: async () => 'own-token', context: async () => ({ teamId: 'own-team' }),
    headers: () => ({ 'x-team-id': 'own-team' }) }, async (url, options) => {
    assert.equal(url.pathname, '/api/entitlement/currentSubscription');
    assert.equal(url.searchParams.get('subscripType'), 'TEAM'); assert.equal(url.searchParams.get('teamId'), 'own-team');
    assert.equal(options.headers['x-team-id'], 'own-team');
    return Response.json({ data: { type: 'TEAM', total: 1000, remaining: 750 } });
  });
  const quota = await client.quota();
  assert.equal(quota.scope, 'team'); assert.equal(quota.totalCredits, 1000);
  assert.equal(quota.usedCredits, 250); assert.equal(quota.remainingCredits, 750);
});
test('a team quota response cannot fall back to a personal subscription', async () => {
  const client = new AccioClient({ token: async () => 'own-token', context: async () => ({ teamId: 'own-team' }) },
    async () => Response.json({ data: { type: 'FREE', total: 20, remaining: 0 } }));
  await assert.rejects(client.quota(), ApiError);
});
test('model catalog caching is separated by the selected space', async () => {
  let teamId = 'own-team', calls = 0;
  const client = new AccioClient({ token: async () => 'own-token', context: async () => ({ teamId }) }, async () => {
    calls++; return Response.json({ data: { providers: [{ provider: 'claude', modelList: [
      teamId === 'own-team' ? model : { ...model, modelCode: 'other-native-id', modelDisplayName: 'Claude Sonnet 5' },
    ] }] } });
  });
  await client.models(); await client.models(); assert.equal(calls, 1);
  teamId = 'another-own-team';
  assert.equal((await client.models())[0].alias, 'claude-sonnet-5'); assert.equal(calls, 2);
});
test('completion excludes hidden reasoning and reports real upstream usage', () => {
  const completion = new Completion(model); completion.apply({ content: { parts: [{ text: 'hidden reasoning', thought: true }, { text: '成功', thought: false }] } }); completion.apply(last);
  const result = completion.openai(); assert.equal(result.choices[0].message.content, '成功'); assert.equal(result.usage.prompt_tokens, 8);
});
test('a real token cap can end before visible text without becoming a transport error', () => {
  const completion = new Completion(model);
  completion.apply({ turn_complete: true, finish_reason: 'MAX_TOKENS', usage_metadata: { prompt_token_count: 11, candidates_token_count: 1, total_token_count: 12 } });
  assert.doesNotThrow(() => completion.validate());
  assert.equal(completion.openai().choices[0].finish_reason, 'length');
  assert.equal(completion.anthropic().stop_reason, 'max_tokens');
  assert.deepEqual(completion.anthropic().content, []);
  const empty = new Completion(model);
  empty.apply({ turn_complete: true, finish_reason: 'MAX_TOKENS', usage_metadata: { prompt_token_count: 11, candidates_token_count: 0 } });
  assert.throws(() => empty.validate(), /no text/);
});
test('tool-start frames with omitted turn_complete never emit empty arguments', () => {
  const completion = new Completion(model);
  const start = { content: { parts: [{ function_call: { id: 'call_1', name: 'echo', args_json: '{}' } }] } };
  assert.deepEqual(completion.apply(start), []);
  assert.equal(completion.tools.length, 0);
  const events = completion.apply({ turn_complete: true, content: { parts: [{ function_call: { id: 'call_1', name: 'echo', args_json: '{"camelCase":"ok"}' } }] } });
  assert.equal(events.length, 1); assert.equal(completion.tools[0].function.arguments, '{"camelCase":"ok"}');
});

async function fixture(t, generate) {
  let captured;
  const client = { catalog: [model], models: async () => [model], resolve: async name => { if (name !== model.alias) throw new ApiError(400, 'model_not_available', 'Unavailable model'); return model; },
    generate: (request, signal) => { captured = request; return generate(request, signal); } };
  const server = createApi({ key, auth: { credentials: null }, client });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, captured: () => captured, call: (path, body, extra = {}) => fetch(origin + path, { method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...extra }, ...(body ? { body: JSON.stringify(body) } : {}) }) };
}
test('HTTP authentication, Host and Origin checks reject unsafe callers', async t => {
  const f = await fixture(t, async function* () { yield frame('ok'); yield last; });
  assert.equal((await fetch(f.origin + '/v1/models')).status, 401);
  const hostStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(f.origin + '/v1/models', { headers: { host: 'attacker.invalid', authorization: `Bearer ${key}` } }, response => {
      response.resume(); resolve(response.statusCode);
    }); request.on('error', reject); request.end();
  });
  assert.equal(hostStatus, 403);
  assert.equal((await f.call('/v1/models', null, { origin: 'https://attacker.invalid' })).status, 403);
  assert.equal((await f.call('/v1/models')).status, 200);
});
test('failed OAuth callbacks remove query values and never show upstream error details', async t => {
  const f = await fixture(t, async function* () {});
  const response = await fetch(f.origin + '/auth/callback?code=private-code&state=bad', { redirect: 'manual' });
  assert.equal(response.status, 303); assert.equal(response.headers.get('location'), '/auth/error');
  const page = await fetch(f.origin + '/auth/error');
  assert.equal(page.status, 400); assert.doesNotMatch(await page.text(), /private-code|TypeError/);
});
test('OpenAI nonstream request returns a real completion shape', async t => {
  const f = await fixture(t, async function* () { yield frame('连接'); yield frame('成功'); yield last; });
  const response = await f.call('/v1/chat/completions', base); const result = await response.json();
  assert.equal(response.status, 200); assert.equal(result.choices[0].message.content, '连接成功');
  assert.equal(response.headers.get('x-accio-model-id'), model.modelCode); assert.equal(f.captured().system_instruction, undefined);
});
test('Claude Desktop one-token probe receives a measured max_tokens response', async t => {
  const f = await fixture(t, async function* () { yield { turn_complete: true, finish_reason: 'MAX_TOKENS', usage_metadata: { prompt_token_count: 11, candidates_token_count: 1, total_token_count: 12 } }; });
  const response = await f.call('/v1/messages', { ...base, max_tokens: 1 });
  const result = await response.json();
  assert.equal(response.status, 200); assert.equal(result.stop_reason, 'max_tokens');
  assert.equal(result.usage.output_tokens, 1); assert.deepEqual(result.content, []);
});
test('OpenAI stream terminates correctly and supplies measured usage', async t => {
  const f = await fixture(t, async function* () { yield frame('成功'); yield last; });
  const response = await f.call('/v1/chat/completions', { ...base, stream: true, stream_options: { include_usage: true } });
  const output = await response.text(); assert.match(output, /chat.completion.chunk/); assert.match(output, /"finish_reason":"stop"/);
  assert.match(output, /"prompt_tokens":8/); assert.match(output, /data: \[DONE\]/);
});
test('Anthropic stream frames text and tools with matching block indexes', async t => {
  const f = await fixture(t, async function* () { yield frame('Checking'); yield { turn_complete: true, content: { parts: [{ function_call: { id: 'call_1', name: 'echo', args_json: '{"x":1}' } }] } }; yield last; });
  const response = await f.call('/v1/messages', { ...base, stream: true }); const output = await response.text();
  assert.match(output, /event: message_start/); assert.match(output, /input_json_delta/); assert.match(output, /"stop_reason":"tool_use"/); assert.match(output, /event: message_stop/);
});
test('upstream failure after partial stream emits an error and never success', async t => {
  const f = await fixture(t, async function* () { yield frame('partial'); throw new ApiError(502, 'test_upstream_error', 'Upstream failed'); });
  const response = await f.call('/v1/chat/completions', { ...base, stream: true }); const output = await response.text();
  assert.match(output, /test_upstream_error/); assert.doesNotMatch(output, /\[DONE\]/);
});
test('empty model output is a failure and Responses is explicitly unsupported', async t => {
  const f = await fixture(t, async function* () { yield last; });
  assert.equal((await f.call('/v1/chat/completions', base)).status, 502);
  assert.equal((await f.call('/v1/responses', {})).status, 501);
});
test('client disconnect aborts upstream generation', async t => {
  let stopped;
  const cancelled = new Promise(resolve => { stopped = resolve; });
  const f = await fixture(t, async function* (_, signal) {
    try { yield frame('started'); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); }
    finally { stopped(); }
  });
  const response = await f.call('/v1/chat/completions', { ...base, stream: true }); const reader = response.body.getReader();
  await reader.read(); await reader.cancel(); await Promise.race([cancelled, new Promise((_, reject) => setTimeout(() => reject(new Error('upstream was not cancelled')), 2000))]);
});
