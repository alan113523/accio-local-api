import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleRoot = fileURLToPath(new URL('../', import.meta.url));

export async function loadSettings(configPath = process.env.CODEX_IMAGE_CONFIG || resolve(moduleRoot, 'bridge.json')) {
  let config = {};
  try { config = JSON.parse(await readFile(configPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const base = dirname(resolve(configPath));
  return {
    ...config,
    codexBin: config.codexBin || 'codex',
    stateDir: resolve(base, config.stateDir || 'state'),
    outputDir: resolve(base, config.outputDir || 'output'),
    timeoutSeconds: config.timeoutSeconds || 600,
  };
}
