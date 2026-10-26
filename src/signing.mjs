import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ApiError } from './auth.mjs';

let activeSigners = 0;
const signerQueue = [];
function reserveSigner(signal) {
  if (signal?.aborted) return Promise.reject(new ApiError(503, 'native_signing_cancelled', 'Request signing was cancelled'));
  if (activeSigners < 2) { activeSigners++; return Promise.resolve(); }
  return new Promise((resolve, reject) => {
    const entry = { resolve: () => { signal?.removeEventListener('abort', cancel); resolve(); } };
    const cancel = () => {
      const index = signerQueue.indexOf(entry);
      if (index !== -1) signerQueue.splice(index, 1);
      reject(new ApiError(503, 'native_signing_cancelled', 'Request signing was cancelled'));
    };
    signerQueue.push(entry);
    signal?.addEventListener('abort', cancel, { once: true });
  });
}
function releaseSigner() {
  const next = signerQueue.shift();
  if (next) next.resolve();
  else activeSigners--;
}
export async function nativeHeaders(url, signal, sgcookie) {
  await reserveSigner(signal);
  try {
    if (signal?.aborted) throw new ApiError(503, 'native_signing_cancelled', 'Request signing was cancelled');
    return await runNativeSigner(url, signal, sgcookie);
  } finally { releaseSigner(); }
}
function runNativeSigner(url, signal, sgcookie) {
  return new Promise((resolve, reject) => {
    const executable = process.platform === 'win32' ? process.env.ACCIO_DESKTOP_EXE || '' : '/Applications/Accio.app/Contents/MacOS/Accio';
    if (!executable) throw new ApiError(503, 'native_signing_unavailable', 'Set ACCIO_DESKTOP_EXE to the official Accio executable');
    const child = spawn(executable, [fileURLToPath(new URL('./native-signing.cjs', import.meta.url)), url], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let output = '', size = 0;
    const stop = () => child.kill();
    const timer = setTimeout(stop, 30000);
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ sgcookie }));
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 512 * 1024) stop(); else output += chunk; });
    child.on('error', () => {});
    child.on('close', (code, signalName) => {
      clearTimeout(timer); signal?.removeEventListener('abort', stop);
      const record = output.split('\n').find(line => line.startsWith('ACCIO_PRIVATE_SIGNING:'));
      if (code !== 0 || !record || size > 512 * 1024) {
        const error = new ApiError(503, 'native_signing_unavailable', 'The installed official Accio request signer is unavailable');
        const diagnostic = output.split('\n').find(line => line.startsWith('ACCIO_SIGNING_ERROR:'));
        error.diagnostic = { exitCode: code, signal: signalName };
        try { if (diagnostic) Object.assign(error.diagnostic, JSON.parse(diagnostic.slice('ACCIO_SIGNING_ERROR:'.length))); } catch {}
        return reject(error);
      }
      try { resolve(JSON.parse(record.slice('ACCIO_PRIVATE_SIGNING:'.length))); }
      catch { reject(new ApiError(503, 'native_signing_unavailable', 'Accio request signing failed')); }
    });
  });
}
