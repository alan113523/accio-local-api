import { mkdir, readFile, copyFile, writeFile, chmod, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

if (process.platform !== 'darwin') throw new Error('This installer supports macOS only');
const run = promisify(execFile);
const source = dirname(fileURLToPath(import.meta.url));
const target = join(homedir(), 'Library/Application Support/Accio Local API');
const label = 'com.local.accio-api';
const agents = join(homedir(), 'Library/LaunchAgents');
const plist = join(agents, label + '.plist');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const files = ['package.json', 'README.md', 'src/auth.mjs', 'src/accio.mjs', 'src/protocol.mjs', 'src/server.mjs', 'src/cli.mjs', 'src/keychain.py', 'src/signing.mjs', 'src/native-signing.cjs'];
const exists = async path => access(path).then(() => true, () => false);
if (await exists(plist)) {
  const old = await readFile(plist, 'utf8');
  if (!old.includes(join(target, 'src/server.mjs'))) throw new Error('Existing LaunchAgent is not owned by this installer');
}
await mkdir(target, { recursive: true, mode: 0o700 });
await mkdir(agents, { recursive: true });
await mkdir(join(target, 'src'), { recursive: true, mode: 0o700 });
for (const relative of files) {
  const destination = join(target, relative);
  if (await exists(destination)) {
    const backup = join(target, 'backups', stamp, relative);
    await mkdir(dirname(backup), { recursive: true, mode: 0o700 });
    await copyFile(destination, backup); await chmod(backup, 0o600);
  }
  await copyFile(join(source, relative), destination); await chmod(destination, 0o600);
}
for (const log of ['server.log', 'server-error.log']) {
  const path = join(target, log);
  await writeFile(path, '', { flag: 'a', mode: 0o600 }); await chmod(path, 0o600);
}
const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(join(target, 'src/server.mjs'))}</string></array>
<key>WorkingDirectory</key><string>${xml(target)}</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${xml(join(target, 'server.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(target, 'server-error.log'))}</string>
</dict></plist>\n`;
if (await exists(plist)) await copyFile(plist, join(target, 'backups', stamp, label + '.plist'));
await writeFile(plist, content, { mode: 0o600 }); await chmod(plist, 0o600);
const domain = `gui/${process.getuid()}`;
await run('/bin/launchctl', ['bootout', domain + '/' + label]).catch(() => {});
for (let attempt = 0; ; attempt++) {
  try { await run('/bin/launchctl', ['bootstrap', domain, plist]); break; }
  catch (error) {
    if (error.code !== 5 || attempt >= 7) throw error;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}
let ready = false;
for (let attempt = 0; attempt < 40; attempt++) {
  try { const response = await fetch('http://127.0.0.1:18437/health', { signal: AbortSignal.timeout(500) }); ready = response.ok && (await response.json()).status === 'running'; } catch {}
  if (ready) break;
  await new Promise(resolve => setTimeout(resolve, 250));
}
if (!ready) throw new Error('LaunchAgent installed, but API did not become ready; check its private service logs');
console.log('Installed Accio Local API at ' + target);
console.log('Local endpoint: http://127.0.0.1:18437/v1');
console.log('Run: node "' + join(target, 'src/cli.mjs') + '" login');
