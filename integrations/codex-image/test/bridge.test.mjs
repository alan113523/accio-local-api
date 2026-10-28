import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { generate } from '../src/codex.mjs';
import { ImageJobs } from '../src/jobs.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const temp = () => mkdtemp(join(here, 'run-'));
const coreOptions = { finalPrompt: 'test', codexBin: process.execPath, codexArgs: [join(here, 'fake-codex.mjs')] };

test('real stdio protocol lifecycle produces a verified image file', async () => {
  const outDir = await temp();
  const result = await generate({ ...coreOptions, outDir });
  assert.equal(result.images.length, 1); assert.deepEqual(result.images[0].dimensions, { width: 2, height: 1 });
  assert.ok(result.images[0].size > 0);
});

test('Windows/native absolute reference paths pass through localImage input', async () => {
  const outDir = await temp(); const first = await generate({ ...coreOptions, outDir });
  const edited = await generate({ ...coreOptions, outDir, referenceImages: [first.images[0].path] });
  assert.equal(edited.images.length, 1);
  await assert.rejects(generate({ ...coreOptions, outDir, referenceImages: ['relative.png'] }), /absolute/);
});

test('existing output files cannot be overwritten', async () => {
  const outDir = await temp(); const first = await generate({ ...coreOptions, outDir, fileName: 'keep' });
  const bytes = await readFile(first.images[0].path);
  await assert.rejects(generate({ ...coreOptions, outDir, fileName: 'keep' }), /EEXIST/);
  assert.deepEqual(await readFile(first.images[0].path), bytes);
});

for (const mode of ['noimage', 'failed']) test(`a ${mode} turn cannot be reported as success`, async () => {
  process.env.FAKE_IMAGE_MODE = mode;
  try { await assert.rejects(generate({ ...coreOptions, outDir: await temp() }), /without producing|failed/); }
  finally { delete process.env.FAKE_IMAGE_MODE; }
});

test('async jobs return promptly and later expose real image content and original prompt', async () => {
  const stateDir = await temp(), outDir = await temp();
  const jobs = new ImageJobs({ stateDir, outputDir: outDir, codexBin: process.execPath, codexArgs: [join(here, 'fake-codex.mjs')] });
  const submitted = await jobs.call('image_generate', { prompt: 'exact prompt' });
  const id = submitted.structuredContent.job_id;
  assert.equal(submitted.structuredContent.status, 'running');
  await jobs.active.get(id).pending;
  const result = await jobs.call('image_status', { job_id: id });
  assert.equal(result.structuredContent.status, 'completed'); assert.equal(result.structuredContent.prompt, 'exact prompt');
  assert.equal(result.content[1].type, 'image'); assert.equal(result.content[1].mimeType, 'image/png');
  const reopened = new ImageJobs({ stateDir, outputDir: outDir });
  assert.equal((await reopened.call('image_status', { job_id: id, include_image: false })).content.length, 1);
});

test('bad edit requests, job ids and failed workers return explicit tool errors', async () => {
  const stateDir = await temp(); const jobs = new ImageJobs({ stateDir, outputDir: stateDir }, async () => { throw new Error('test failure'); });
  assert.equal((await jobs.call('image_edit', { prompt: 'edit' })).isError, true);
  assert.equal((await jobs.call('image_status', { job_id: '../outside' })).isError, true);
  const response = await jobs.call('image_generate', { prompt: 'test' }); const id = response.structuredContent.job_id;
  await jobs.active.get(id).pending;
  const failed = await jobs.call('image_status', { job_id: id });
  assert.equal(failed.isError, true); assert.equal(failed.structuredContent.status, 'failed');
});

test('concurrent submissions cannot start two quota-consuming workers', async () => {
  const stateDir = await temp(); let calls = 0, finish;
  const jobs = new ImageJobs({ stateDir, outputDir: stateDir }, () => { calls++; return new Promise(r => { finish = r; }); });
  const results = await Promise.all([jobs.call('image_generate', { prompt: 'first' }), jobs.call('image_generate', { prompt: 'second' })]);
  assert.equal(calls, 1); assert.equal(results[1].isError, true);
  const id = results[0].structuredContent.job_id, pending = jobs.active.get(id).pending;
  finish({ images: [], failures: [] }); await pending;
  assert.equal((await jobs.call('image_status', { job_id: id })).structuredContent.status, 'failed');
});

test('MCP initialize, list and validation work over an actual stdio connection', async t => {
  const child = spawn(process.execPath, [join(here, '../src/mcp-server.mjs')], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => child.kill()); let buffer = '', id = 0; const pending = new Map();
  child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => {
    buffer += chunk; const lines = buffer.split('\n'); buffer = lines.pop();
    for (const line of lines.filter(Boolean)) { const msg = JSON.parse(line); pending.get(msg.id)?.(msg); }
  });
  const ask = (method, params = {}) => new Promise(resolve => { const key = ++id; pending.set(key, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: key, method, params }) + '\n'); });
  assert.equal((await ask('initialize')).result.serverInfo.name, 'codex-image-bridge');
  assert.deepEqual((await ask('tools/list')).result.tools.map(x => x.name), ['image_generate', 'image_edit', 'image_status']);
  assert.equal((await ask('tools/call', { name: 'image_edit', arguments: { prompt: 'edit' } })).result.isError, true);
});
