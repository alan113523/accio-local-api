import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { convertRequest, Completion } from '../src/protocol.mjs';
import { createApi } from '../src/server.mjs';

const model = { alias: 'test-model', modelCode: 'test', modelDisplayName: 'Test' };
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4ZkAAAAASUVORK5CYII=';
const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } };
const inline = { inline_data: { mime_type: 'image/png', data: png }, thought: false };
const convert = (messages, protocol = 'anthropic') => convertRequest({ model: model.alias, messages }, protocol, model);

test('current Claude Code adaptive display and keep-all context hints preserve the request', () => {
  const body = { model: model.alias, messages: [{ role: 'user', content: [image] }],
    thinking: { type: 'adaptive', display: 'updates' },
    context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] } };
  const converted = convertRequest(body, 'anthropic', model);
  assert.deepEqual(converted.contents[0].parts, [inline]);
  assert.equal(converted.include_thoughts, false);
  assert.equal(converted.context_management, undefined);
  for (const context of [{ edits: [{ type: 'clear_tool_uses_20250919' }] }, { edits: [{ type: 'clear_thinking_20251015', keep: 1 }] }]) {
    assert.throws(() => convertRequest({ ...body, context_management: context }, 'anthropic', model), /no-op/);
  }
});

test('Anthropic image input retains pixel bytes and text order', () => {
  const parts = convert([{ role: 'user', content: [{ type: 'text', text: 'before' }, image, { type: 'text', text: 'after' }] }]).contents[0].parts;
  assert.deepEqual(parts, [{ text: 'before', thought: false }, inline, { text: 'after', thought: false }]);
});

test('Anthropic URL and OpenAI URL/data inputs use native image fields', () => {
  const url = 'https://example.invalid/photo.webp?size=1';
  const expected = { file_data: { file_uri: url, mime_type: 'image/webp' }, thought: false };
  assert.deepEqual(convert([{ role: 'user', content: [{ type: 'image', source: { type: 'url', url } }] }]).contents[0].parts, [expected]);
  for (const [source, target] of [[url, expected], [`data:image/png;base64,${png}`, inline]]) {
    assert.deepEqual(convert([{ role: 'user', content: [{ type: 'image_url', image_url: { url: source } }] }], 'openai').contents[0].parts, [target]);
  }
});

for (const protocol of ['anthropic', 'openai']) test(`${protocol} tool image result remains pixels alongside matched function response`, () => {
  const messages = protocol === 'anthropic' ? [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'read_1', name: 'Read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read_1', content: [{ type: 'text', text: 'loaded' }, image] }] },
  ] : [
    { role: 'assistant', content: null, tool_calls: [{ type: 'function', id: 'read_1', function: { name: 'Read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'read_1', content: [{ type: 'text', text: 'loaded' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } }] },
  ];
  const parts = convert(messages, protocol).contents[1].parts;
  assert.deepEqual(parts, [{ function_response: { id: 'read_1', name: 'Read', response_json: '{"result":"loaded"}' } }, inline]);
});

test('invalid pixels, malformed base64, unsupported formats and local file URLs fail explicitly', () => {
  for (const source of [
    { type: 'base64', media_type: 'image/png', data: '!!!!' },
    { type: 'base64', media_type: 'image/jpeg', data: png },
    { type: 'base64', media_type: 'image/gif', data: png },
    { type: 'url', url: 'file:///private.png' },
    { type: 'url', url: 'https://user:secret@example.invalid/x.png' },
    { type: 'url', url: 'data:image/png,invalid' },
  ]) assert.throws(() => convert([{ role: 'user', content: [{ type: 'image', source }] }]), e => e.status === 400 && e.code === 'invalid_image');
});

test('structured upstream pictures cannot disappear even when text shares the frame', () => {
  for (const field of ['inline_data', 'inlineData', 'file_data', 'fileData']) for (const text of [[], [{ text: 'caption' }]]) {
    const c = new Completion(model);
    assert.throws(() => c.apply({ content: { parts: [...text, { [field]: { data: png } }] } }), e => e.code === 'unsupported_image_response');
    assert.equal(c.text, '');
  }
});

for (const stream of [false, true]) test(`HTTP image input reaches upstream, stream=${stream}`, async t => {
  let received;
  const client = { resolve: async () => model, async *generate(request) {
    received = request; yield { content: { parts: [{ text: 'red' }] }, turn_complete: true };
  } };
  const server = createApi({ key: 'test-key', auth: {}, client });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/messages`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'test-key' },
    body: JSON.stringify({ model: model.alias, stream, messages: [{ role: 'user', content: [image] }] }) });
  assert.equal(response.status, 200); assert.match(await response.text(), /red/);
  assert.deepEqual(received.contents[0].parts, [inline]);
});
