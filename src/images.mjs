import { ApiError } from './auth.mjs';

const fail = message => { throw new ApiError(400, 'invalid_image', message); };
const mimeTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);

function inlineImage(mime, data) {
  if (!mimeTypes.has(mime)) fail('Supported image formats are PNG, JPEG, and WebP');
  if (typeof data !== 'string' || !data || data.length % 4 !== 0 || Buffer.from(data, 'base64').toString('base64') !== data) {
    fail('Image data must be nonempty standard base64');
  }
  const bytes = Buffer.from(data, 'base64');
  const detected = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? 'image/png'
    : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? 'image/jpeg'
    : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : null;
  if (detected !== mime) fail('Image bytes do not match the declared image format');
  return { inline_data: { mime_type: mime, data }, thought: false };
}

function urlImage(value) {
  if (typeof value !== 'string') fail('Image URL must be a string');
  if (value.startsWith('data:')) {
    const match = /^data:([^;,]+);base64,(.*)$/.exec(value);
    if (!match) fail('Image data URL must contain a MIME type and base64 data');
    return inlineImage(match[1], match[2]);
  }
  let url;
  try { url = new URL(value); } catch { fail('Image URL must be an absolute HTTP or HTTPS URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('Use an HTTP or HTTPS image URL without embedded credentials');
  const extension = url.pathname.toLowerCase();
  const mime = extension.endsWith('.png') ? 'image/png' : extension.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
  return { file_data: { file_uri: url.href, mime_type: mime }, thought: false };
}

export function imagePart(block, protocol) {
  if (protocol === 'openai' && block?.type === 'image_url') return urlImage(block.image_url?.url);
  if (protocol === 'anthropic' && block?.type === 'image') {
    if (block.source?.type === 'base64') return inlineImage(block.source.media_type, block.source.data);
    if (block.source?.type === 'url') return urlImage(block.source.url);
    fail('Image source must use base64 or url');
  }
  return null;
}
