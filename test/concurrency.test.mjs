import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createApi } from '../src/server.mjs';

test('default generation capacity accepts 50, rejects request 51, and releases slots', { timeout: 15000 }, async t => {
  const model = { alias: 'claude-opus-5-5', modelCode: 'test-model', modelDisplayName: 'Test model' };
  let entered = 0, release;
  const blocked = new Promise(resolve => { release = resolve; });
  const server = createApi({ key: 'test-key', auth: {}, client: {
    resolve: async () => model,
    generate: async function* () {
      entered++;
      await blocked;
      yield { content: { parts: [{ text: 'OK', thought: false }] } };
      yield { turn_complete: true, finish_reason: 'STOP', usage_metadata: { prompt_token_count: 1, candidates_token_count: 1, total_token_count: 2 } };
    },
  } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { release(); server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: 'Bearer test-key', 'content-type': 'application/json' };
  const send = () => fetch(base + '/v1/messages', { method: 'POST', headers,
    body: JSON.stringify({ model: model.alias, max_tokens: 16, messages: [{ role: 'user', content: 'OK' }] }) });
  const requests = Array.from({ length: 50 }, send);
  while (entered < 50) await nextTurn();
  const busy = await (await fetch(base + '/status', { headers })).json();
  assert.equal(busy.generationConcurrencyLimit, 50);
  assert.equal(busy.activeGenerationRequests, 50);
  const overflow = await send();
  assert.equal(overflow.status, 429);
  assert.deepEqual((await overflow.json()).error, { type: 'local_capacity', message: 'Local API generation concurrency limit (50) reached' });
  release();
  for (const response of await Promise.all(requests)) {
    assert.equal(response.status, 200);
    assert.equal((await response.json()).content[0].text, 'OK');
  }
  const idle = await (await fetch(base + '/status', { headers })).json();
  assert.equal(idle.activeGenerationRequests, 0);
  assert.equal((await send()).status, 200);
});
