// Explicit manual quota-using test; no business tools or files are accessed.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { STATE_DIR, PORT } from '../src/server.mjs';
import { parseSse } from '../src/accio.mjs';

const key = (await readFile(join(STATE_DIR, 'api.key'), 'utf8')).trim();
const origin = `http://127.0.0.1:${PORT}`;
const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
const report = { time: new Date().toISOString(), model: 'claude-opus-5-5', toolsExecuted: ['in-memory echo_test'], requests: [], success: false };
const messages = [{ role: 'user', content: '请调用一次 echo_test 工具，参数 camelCase 固定为 ACCIO_TOOL_CANARY。收到工具结果后仅回复工具返回的文本。' }];
const tools = [{ type: 'function', function: { name: 'echo_test', description: 'Returns the supplied test marker without side effects.', parameters: {
  type: 'object', properties: { camelCase: { type: 'string' } }, required: ['camelCase'], additionalProperties: false,
} } }];
const base = { model: report.model, reasoning_effort: 'low', max_tokens: 512, tools };
async function chat(body) {
  const start = performance.now();
  const response = await fetch(origin + '/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(125000) });
  const data = await response.json();
  report.requests.push({ status: response.status, totalMs: Math.round(performance.now() - start), usage: data.usage, finishReason: data.choices?.[0]?.finish_reason });
  if (!response.ok) throw new Error(data.error?.message || 'Request failed');
  return data.choices[0].message;
}
try {
  const assistant = await chat({ ...base, messages });
  const calls = assistant.tool_calls || [];
  if (calls.length !== 1 || calls[0].function.name !== 'echo_test') throw new Error('Model did not return the expected client tool call');
  const input = JSON.parse(calls[0].function.arguments);
  report.receivedToolInput = input;
  if (input.camelCase !== 'ACCIO_TOOL_CANARY') throw new Error('Tool input was not preserved');
  const final = await chat({ ...base, messages: [...messages, assistant, { role: 'tool', tool_call_id: calls[0].id, content: input.camelCase }] });
  report.finalText = final.content;
  if (final.content?.trim() !== 'ACCIO_TOOL_CANARY') throw new Error('Tool result round trip did not produce the test marker');
  const start = performance.now();
  const response = await fetch(origin + '/v1/messages', { method: 'POST', headers: { 'x-api-key': key, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: report.model, max_tokens: 128, reasoning_effort: 'low', stream: true,
      system: '只输出用户指定的测试短语。', messages: [{ role: 'user', content: '只回复：Anthropic格式成功' }] }), signal: AbortSignal.timeout(125000) });
  if (!response.ok) throw new Error('Messages endpoint failed');
  let text = '', stopped = false, usage;
  for await (const event of parseSse(response.body)) {
    const data = JSON.parse(event.data);
    if (data.type === 'error') throw new Error(data.error.message);
    if (data.delta?.type === 'text_delta') text += data.delta.text;
    if (data.type === 'message_delta') usage = data.usage;
    if (data.type === 'message_stop') stopped = true;
  }
  report.anthropicStream = { status: response.status, text, stopped, usage, totalMs: Math.round(performance.now() - start) };
  report.success = stopped && text.trim() === 'Anthropic格式成功';
} catch (error) { report.error = error.message; }
if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.success ? 0 : 1;
