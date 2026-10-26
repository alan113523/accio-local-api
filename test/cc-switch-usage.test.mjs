import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const directory = new URL('../examples/cc-switch/', import.meta.url);
const code = await readFile(new URL('accio-usage-query.js', directory), 'utf8');
const config = JSON.parse(await readFile(new URL('usage-script.json', directory), 'utf8'));
const evaluate = (baseUrl = 'http://127.0.0.1:18437') => runInNewContext(
  code.replaceAll('{{baseUrl}}', baseUrl).replaceAll('{{apiKey}}', 'SYNTHETIC_KEY'), {}, { timeout: 1000 },
);
const plain = value => JSON.parse(JSON.stringify(value));

test('portable CC Switch settings refresh every minute and inherit provider credentials', () => {
  assert.deepEqual(Object.keys(config).sort(), ['enabled', 'language', 'code', 'timeout', 'templateType', 'autoQueryInterval'].sort());
  assert.equal(config.enabled, true);
  assert.equal(config.language, 'javascript');
  assert.equal(config.timeout, 30);
  assert.equal(config.templateType, 'general');
  assert.equal(config.autoQueryInterval, 1);
  assert.equal(config.code, code.trimEnd());
});

test('quota request handles root, v1, trailing slashes and another local port', () => {
  for (const baseUrl of ['http://127.0.0.1:18437', 'http://127.0.0.1:18437/', 'http://127.0.0.1:18437/v1', 'http://127.0.0.1:18437/v1///', 'http://localhost:19000/v1/']) {
    const request = evaluate(baseUrl).request;
    assert.equal(request.url, baseUrl.includes('19000') ? 'http://localhost:19000/quota' : 'http://127.0.0.1:18437/quota');
    assert.equal(request.method, 'GET');
    assert.deepEqual(plain(request.headers), { Authorization: 'Bearer SYNTHETIC_KEY' });
  }
});

test('team credit display uses the API counters and credit unit', () => {
  const result = evaluate().extractor({ scope: 'team', totalCredits: 800, usedCredits: 312, remainingCredits: 488 });
  assert.deepEqual(plain(result), { isValid: true, planName: 'Accio 团队订阅', remaining: 488, used: 312, total: 800, unit: '积分', extra: '已用 312 / 总额 800' });
});

test('personal scope and exhausted credit balances remain valid', () => {
  const result = evaluate().extractor({ scope: 'personal', totalCredits: 50, usedCredits: 50, remainingCredits: 0 });
  assert.equal(result.isValid, true);
  assert.equal(result.planName, 'Accio 个人订阅');
  assert.equal(result.remaining, 0);
  assert.equal(result.unit, '积分');
});

test('missing or malformed quota data fails without fabricating zero credit', () => {
  const valid = { scope: 'team', totalCredits: 800, usedCredits: 312, remainingCredits: 488 };
  for (const response of [null, {}, { ...valid, scope: 'unknown' }, { ...valid, totalCredits: undefined }, { ...valid, remainingCredits: '488' }, { ...valid, usedCredits: -1 }, { ...valid, remainingCredits: NaN }, { ...valid, totalCredits: Infinity }]) {
    const result = evaluate().extractor(response);
    assert.equal(result.isValid, false);
    assert.equal(result.invalidMessage, 'Accio 额度查询失败');
    assert.equal(Object.hasOwn(result, 'remaining'), false);
  }
});

test('an API account or space error stays visible to the user', () => {
  const result = evaluate().extractor({ error: { message: 'Selected space is unavailable' } });
  assert.equal(result.isValid, false);
  assert.equal(result.invalidMessage, 'Selected space is unavailable');
  assert.equal(Object.hasOwn(result, 'remaining'), false);
});
