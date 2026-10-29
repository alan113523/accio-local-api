import { readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const moduleRoot = fileURLToPath(new URL('../', import.meta.url));

export async function loadSettings(configPath = process.env.CODEX_IMAGE_CONFIG || resolve(moduleRoot, 'bridge.json')) {
  let config = {};
  try { config = JSON.parse(await readFile(configPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const base = dirname(resolve(configPath));
  return {
    ...config,
    backend: config.backend || 'codex',
    accioBaseUrl: config.accioBaseUrl || 'http://127.0.0.1:18437',
    accioApiKeyFile: config.accioApiKeyFile ? resolve(base, config.accioApiKeyFile) : join(process.env.ACCIO_API_STATE_DIR ||
      (process.platform === 'win32' ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Accio Local API', 'state')
        : join(homedir(), 'Library', 'Application Support', 'Accio Local API')), 'api.key'),
    codexBin: config.codexBin || 'codex',
    stateDir: resolve(base, config.stateDir || 'state'),
    outputDir: resolve(base, config.outputDir || 'output'),
    timeoutSeconds: config.timeoutSeconds || 600,
  };
}
