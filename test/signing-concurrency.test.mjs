import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { nativeHeaders } from '../src/signing.mjs';

function fakeSigners(t, automatic) {
  const previousExecutable = process.env.ACCIO_DESKTOP_EXE;
  process.env.ACCIO_DESKTOP_EXE = 'synthetic-accio-executable';
  t.after(() => {
    if (previousExecutable === undefined) delete process.env.ACCIO_DESKTOP_EXE;
    else process.env.ACCIO_DESKTOP_EXE = previousExecutable;
  });
  const children = [];
  let active = 0, peak = 0;
  t.mock.method(childProcess, 'spawn', () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    children.push(child); active++; peak = Math.max(peak, active);
    let closed = false;
    child.finish = (code = 0) => {
      if (closed) return;
      closed = true;
      if (code === 0) child.stdout.write('ACCIO_PRIVATE_SIGNING:{"test-signature":"ok"}\n');
      active--; child.emit('close', code, null);
    };
    child.kill = () => child.finish(1);
    if (automatic) setImmediate(() => child.finish());
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { children, peak: () => peak };
}

test('50 signing requests use at most two subprocesses and all drain', async t => {
  const mock = fakeSigners(t, true);
  const results = await Promise.all(Array.from({ length: 50 }, () => nativeHeaders('https://example.test', undefined, 'test-cookie')));
  assert.equal(mock.children.length, 50);
  assert.equal(mock.peak(), 2);
  assert.ok(results.every(result => result['test-signature'] === 'ok'));
});

test('queued signing cancellation never spawns and releases no extra slot', async t => {
  const mock = fakeSigners(t, false);
  const first = nativeHeaders('https://example.test');
  const second = nativeHeaders('https://example.test');
  const controller = new AbortController();
  const cancelled = nativeHeaders('https://example.test', controller.signal);
  const rejected = assert.rejects(cancelled, error => error.code === 'native_signing_cancelled');
  controller.abort();
  await rejected; await nextTurn();
  assert.equal(mock.children.length, 2);
  mock.children[0].finish(); mock.children[1].finish();
  await Promise.all([first, second]);
  const next = nativeHeaders('https://example.test');
  await nextTurn(); mock.children[2].finish(); await next;
  assert.equal(mock.peak(), 2);
});

test('signing failure frees the slot for queued work', async t => {
  const mock = fakeSigners(t, false);
  const first = nativeHeaders('https://example.test');
  const failed = assert.rejects(first, error => error.code === 'native_signing_unavailable');
  const second = nativeHeaders('https://example.test');
  const third = nativeHeaders('https://example.test');
  await nextTurn(); mock.children[0].finish(1);
  await failed; await nextTurn();
  assert.equal(mock.children.length, 3);
  mock.children[1].finish(); mock.children[2].finish();
  await Promise.all([second, third]);
  assert.equal(mock.peak(), 2);
});
