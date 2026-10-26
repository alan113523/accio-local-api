// Private stdio helper. Only uses the installed official client's request signer.
// No vendor credential-store or app-setting methods. Native initialization uses
// only the sgcookie issued to this bridge's own independent OAuth login.
const { createHash } = require('node:crypto');
const { dirname, join } = require('node:path');
const root = process.platform === 'win32'
  ? join(dirname(process.env.ACCIO_DESKTOP_EXE || ''), 'resources/app.asar.unpacked/node_modules/@phoenix-common/security-guard/prebuild')
  : '/Applications/Accio.app/Contents/Resources/app.asar.unpacked/node_modules/@phoenix-common/security-guard/prebuild';
async function main() {
  const url = new URL(process.argv[2]);
  if (url.protocol !== 'https:' || url.hostname !== 'phoenix-gw.alibaba.com'
    || url.pathname !== '/api/adk/llm/generateContent' || !/^[a-f0-9]{32}$/.test(url.searchParams.get('sg_k') || '')
    || [...url.searchParams.keys()].some(key => key !== 'sg_k')) throw new Error('unsupported signing target');
  const addon = require(join(root, `${process.platform}-${process.arch}`, 'security_guard.node'));
  if (addon.isStub || typeof addon.getSecurityFactorsForWeb !== 'function') throw new Error('native signer unavailable');
  let input = '';
  for await (const chunk of process.stdin) { input += chunk; if (input.length > 65536) throw new Error('input too large'); }
  const data = input ? JSON.parse(input) : {};
  if (typeof data.sgcookie === 'string' && data.sgcookie) {
    try { await addon.initUmidBySgCookie(data.sgcookie); }
    catch (error) {
      if (error.errorCode !== 1) {
        // Same initialization fallback used by the installed native client.
        try { await addon.initUmid(6); }
        catch (fallbackError) { if (fallbackError.errorCode !== 1) throw fallbackError; }
      }
    }
  }
  const signingInput = process.platform === 'win32'
    ? { appkey: '35336201', urlInput: url.href }
    : { appkey: '35337600', api: url.hostname + url.pathname,
      data: createHash('md5').update(url.pathname + url.search, 'utf8').digest('hex') };
  const raw = addon.getSecurityFactorsForWeb(JSON.stringify(signingInput));
  const factors = JSON.parse(raw), headers = {};
  if (!factors || typeof factors !== 'object' || Array.isArray(factors)) throw new Error('invalid signer response');
  for (const [key, value] of Object.entries(factors)) {
    if (!/^[A-Za-z0-9-]+$/.test(key)) throw new Error('invalid header name');
    if (['string', 'number', 'boolean'].includes(typeof value)) headers[key] = encodeURIComponent(String(value));
  }
  if (!Object.keys(headers).length) throw new Error('empty signer response');
  process.stdout.write('\nACCIO_PRIVATE_SIGNING:' + JSON.stringify(headers) + '\n');
}
main().catch(error => {
  const code = error.errorCode ?? error.code;
  process.stdout.write('\nACCIO_SIGNING_ERROR:' + JSON.stringify({
    name: error.name, code: typeof code === 'number' ? code : undefined,
    missingMethod: /not a function/.test(error.message || ''),
    alreadyInitialized: /already.*initial/i.test(error.message || ''),
  }) + '\n');
  process.exitCode = 1;
});
