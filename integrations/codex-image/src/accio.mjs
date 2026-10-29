import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, isAbsolute } from 'node:path';
import { imageSize } from './codex.mjs';

export function accioEndpoint(base, edit) {
  const url = new URL(base || 'http://127.0.0.1:18437');
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password || url.search || url.hash || !['', '/', '/v1', '/v1/'].includes(url.pathname)) {
    throw new Error('Accio image API must be a local http://127.0.0.1 or http://localhost address; its private key is never sent to a remote host');
  }
  return new URL(edit ? '/v1/images/edits' : '/v1/images/generations', url);
}

function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return { mime: 'image/png', extension: '.png' };
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mime: 'image/jpeg', extension: '.jpg' };
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', extension: '.webp' };
  throw new Error('Accio images must contain PNG, JPEG, or WebP data');
}

export async function generateAccio({ finalPrompt, referenceImages = [], outDir, timeoutSeconds = 360, progress, backendSettings = {} }, fetchImpl = fetch) {
  const endpoint = accioEndpoint(backendSettings.accioBaseUrl, referenceImages.length > 0);
  const keyFile = backendSettings.accioApiKeyFile;
  if (typeof keyFile !== 'string' || !isAbsolute(keyFile)) throw new Error('Configure accioApiKeyFile as the absolute path of your Accio Local API api.key');
  const key = (await readFile(keyFile, 'utf8')).trim();
  if (!/^accio-local-[a-f0-9]{64}$/.test(key)) throw new Error('Accio Local API key file is invalid');
  const references = []; let totalBytes = 0;
  for (const path of referenceImages) {
    if (!isAbsolute(path)) throw new Error('Reference images must use absolute local paths');
    const info = await stat(path);
    if (!info.isFile() || totalBytes + info.size > 5 * 1024 * 1024) throw new Error('Accio reference images must total at most 5 MiB before base64 encoding');
    const bytes = await readFile(path); totalBytes += bytes.length;
    if (totalBytes > 5 * 1024 * 1024) throw new Error('Accio reference images exceed the 5 MiB limit');
    references.push({ mime_type: imageType(bytes).mime, data: bytes.toString('base64') });
  }
  const body = { prompt: finalPrompt, model: backendSettings.accioModel || 'gpt-image-2', n: 1, response_format: 'b64_json',
    ...(backendSettings.accioSize ? { size: backendSettings.accioSize } : {}),
    ...(backendSettings.accioResolution ? { resolution: backendSettings.accioResolution } : {}),
    ...(references.length ? { reference_images: references } : {}) };
  progress?.('requesting image through Accio');
  const response = await fetchImpl(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(timeoutSeconds * 1000) });
  const chunks = []; let length = 0;
  for await (const chunk of response.body || []) {
    length += chunk.length;
    if (length > 25 * 1024 * 1024) throw new Error('Accio Local API image response exceeds 25 MiB');
    chunks.push(chunk);
  }
  let result;
  try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('Accio Local API returned an invalid image response'); }
  if (!response.ok) throw new Error(`Accio image request failed (HTTP ${response.status}): ${result.error?.message || 'check the local API'}; no automatic retry`);
  const encoded = result.data?.[0]?.b64_json;
  if (typeof encoded !== 'string' || !encoded || Buffer.from(encoded, 'base64').toString('base64') !== encoded) throw new Error('Accio returned no valid inline image; the request was not retried');
  const bytes = Buffer.from(encoded, 'base64'), type = imageType(bytes);
  await mkdir(outDir, { recursive: true });
  const path = join(outDir, `accio-${randomUUID()}${type.extension}`);
  await writeFile(path, bytes, { flag: 'wx' });
  const dimensions = await imageSize(path);
  if (!dimensions) throw new Error('Accio returned an image with an unreadable header');
  progress?.('Accio image saved');
  return { images: [{ path, size: bytes.length, dimensions, backend: 'accio', actualModel: result.accio?.actual_model || null,
    fallbackApplied: result.accio?.fallback_applied === true }], failures: [], outDir };
}
