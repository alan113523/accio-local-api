// Stdio framing adapted from qiaomu-codex-imagegen (MIT; see LICENSE).
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ImageJobs, TOOLS, disabledMcpServers } from './jobs.mjs';
import { loadSettings } from './settings.mjs';

const settings = await loadSettings();
settings.disabledMcp = disabledMcpServers(join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml'));
const jobs = new ImageJobs(settings);
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk; const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { send({ id: null, error: { code: -32700, message: 'Invalid JSON' } }); continue; }
    const { id, method, params } = msg;
    if (method === 'initialize') send({ id, result: { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'codex-image-bridge', version: '0.1.0' } } });
    else if (method === 'ping') send({ id, result: {} });
    else if (method === 'tools/list') send({ id, result: { tools: TOOLS } });
    else if (method === 'tools/call') void jobs.call(params?.name, params?.arguments || {}).then(result => send({ id, result }));
    else if (id !== undefined) send({ id, error: { code: -32601, message: 'Unknown method' } });
  }
});
process.stdin.on('end', () => { void Promise.all([...jobs.active.values()].map(x => x.pending)).finally(() => process.exit(0)); });
console.error('[codex-image-bridge] ready');
