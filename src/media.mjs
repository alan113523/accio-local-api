import { randomUUID } from 'node:crypto';
import { APP_VERSION, GATEWAY, ApiError } from './auth.mjs';
import { imagePart } from './images.mjs';

const invalid = message => { throw new ApiError(400, 'invalid_image_request', message); };
const allowedModels = new Set(['gpt-image-2', 'gemini-3.1-flash-image', 'gemini-3-pro-image']);

export function mediaRequest(body, edit = false) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('Image request must be an object');
  const allowed = new Set(['prompt', 'model', 'size', 'aspect_ratio', 'resolution', 'reference_images', 'n', 'response_format']);
  if (Object.keys(body).some(key => !allowed.has(key))) invalid('Unsupported image request parameter');
  if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 30000) invalid('prompt must contain 1–30000 characters');
  const model = body.model ?? 'gpt-image-2';
  if (!allowedModels.has(model)) invalid('Use a native image model: gpt-image-2, gemini-3.1-flash-image, or gemini-3-pro-image; media catalog tier IDs are not accepted by this transport');
  if (body.n != null && body.n !== 1) invalid('Only n=1 is supported');
  if (body.response_format != null && !['b64_json', 'url'].includes(body.response_format)) invalid('response_format must be b64_json or url');
  if (body.size != null && !/^\d{3,4}x\d{3,4}$/.test(body.size)) invalid('size must use WIDTHxHEIGHT');
  if (body.aspect_ratio != null && !/^\d{1,2}:\d{1,2}$/.test(body.aspect_ratio)) invalid('aspect_ratio must use WIDTH:HEIGHT');
  if (body.resolution != null && !['1K', '2K', '4K'].includes(body.resolution)) invalid('resolution must be 1K, 2K, or 4K');
  const references = body.reference_images ?? [];
  if (!Array.isArray(references) || references.length > 8 || (edit && !references.length) || (!edit && references.length)) invalid('Use the edits endpoint with 1–8 base64 reference images');
  const referenceImages = references.map(reference => {
    if (!reference || typeof reference !== 'object' || Object.keys(reference).some(key => !['mime_type', 'data'].includes(key))) invalid('Each reference image requires mime_type and base64 data');
    const part = imagePart({ type: 'image', source: { type: 'base64', media_type: reference.mime_type, data: reference.data } }, 'anthropic');
    return { base64: part.inline_data.data, mimeType: part.inline_data.mime_type };
  });
  return {
    modelCode: model, prompt: body.prompt, operation: edit ? 'IMAGE_EDIT' : 'IMAGE_GENERATION',
    taskType: edit ? 'auto_generation' : 'auto', resolution: body.resolution ?? '1K',
    ...(body.size ? { size: body.size } : model === 'gpt-image-2' && !edit && !body.aspect_ratio ? { size: '1024x1024' } : {}),
    ...(body.aspect_ratio ? { aspectRatio: body.aspect_ratio } : {}),
    ...(edit ? { referenceImages } : {}),
  };
}

async function mediaJson(response) {
  if (!response.body) throw new ApiError(502, 'invalid_media_response', 'Accio returned an empty media response');
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 25 * 1024 * 1024) throw new ApiError(502, 'media_response_too_large', 'Accio media response exceeds 25 MiB');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ApiError(502, 'invalid_media_response', 'Accio returned non-JSON media data'); }
}

export class AccioImages {
  constructor(auth, fetchImpl = fetch) { this.auth = auth; this.fetch = fetchImpl; }
  async generate(body, edit, signal) {
    const request = mediaRequest(body, edit);
    await this.auth.context(signal);
    const accessToken = await this.auth.token();
    const payload = { ...request, accessToken, requestId: randomUUID(), messageId: randomUUID(), clientVersion: APP_VERSION };
    const response = await this.fetch(new URL(edit ? '/api/media/image/edit' : '/api/media/image/generate', GATEWAY), {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', ...this.auth.headers() },
      body: JSON.stringify(payload), signal, redirect: 'error',
    });
    // Generation is billable: never replay a failed or ambiguous request.
    if (!response.ok) {
      await response.body?.cancel();
      throw new ApiError(response.status === 429 ? 429 : 502, 'accio_image_http_error', `Accio image gateway returned HTTP ${response.status}; the request was not retried`);
    }
    const raw = await mediaJson(response);
    if (raw.success !== true || !raw.data || typeof raw.data !== 'object') {
      const code = /^[A-Za-z0-9_.-]{1,64}$/.test(String(raw.code)) ? String(raw.code) : 'rejected';
      throw new ApiError(code === '429' ? 429 : 502, 'accio_image_rejected', `Accio image request failed (${code}); the request was not retried`);
    }
    const data = raw.data; let image;
    if (body.response_format === 'url') {
      let url;
      try { url = new URL(data.url); } catch { throw new ApiError(502, 'image_delivery_missing', 'Accio returned no image URL'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new ApiError(502, 'invalid_media_response', 'Accio returned an invalid image URL');
      image = { url: url.href };
    } else {
      let base64 = data.base64;
      if (typeof base64 === 'string') base64 = base64.replace(/^data:[^;]+;base64,/, '');
      try { imagePart({ type: 'image', source: { type: 'base64', media_type: data.mimeType || 'image/png', data: base64 } }, 'anthropic'); }
      catch { throw new ApiError(502, 'image_delivery_missing', 'Accio returned no valid inline image; use response_format=url if the gateway omitted base64 data'); }
      image = { b64_json: base64 };
    }
    return { created: Math.floor(Date.now() / 1000), data: [image], accio: {
      backend: 'accio', requested_model: request.modelCode, actual_model: data.actualModel || null,
      fallback_applied: data.fallbackApplied === true,
      ...(typeof data.width === 'number' ? { width: data.width } : {}),
      ...(typeof data.height === 'number' ? { height: data.height } : {}),
    } };
  }
}
