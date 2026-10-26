import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { STATE_DIR, PORT } from './server.mjs';

const command = process.argv[2] || 'status';
if (!['status', 'login', 'models', 'quota', 'key'].includes(command)) throw new Error('Use status, login, models, quota, or key');
const key = (await readFile(join(STATE_DIR, 'api.key'), 'utf8')).trim();
if (command === 'key') {
  console.log(key);
} else {
  const path = { status: '/status', login: '/auth/start', models: '/v1/models', quota: '/quota' }[command];
  const response = await fetch(`http://127.0.0.1:${PORT}${path}`, { method: command === 'login' ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30000) });
  const data = await response.json();
  if (!response.ok) { console.error(JSON.stringify(data)); process.exitCode = 1; }
  else console.log(command === 'login' ? data.url : JSON.stringify(data, null, 2));
}
