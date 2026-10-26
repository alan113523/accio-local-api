import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const GATEWAY = 'https://phoenix-gw.alibaba.com';
export const APP_VERSION = process.env.ACCIO_APP_VERSION || '0.34.5';
export const APP_KEY = process.platform === 'win32' ? '35336201' : '35337600';
export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

async function readOfficialSpace() {
  try {
    const space = JSON.parse(await readFile(join(homedir(), '.accio/state/current-space.json'), 'utf8'));
    return { kind: space.kind, accountId: space.accountId, teamId: space.teamId };
  } catch {
    throw new ApiError(503, 'official_space_unavailable', 'Open Accio and select a space before using the local API');
  }
}

export async function upstreamJson(path, options = {}, fetchImpl = fetch) {
  const response = await fetchImpl(new URL(path, GATEWAY), {
    ...options, headers: { 'content-type': 'application/json', accept: 'application/json',
      'x-app-version': APP_VERSION, 'x-os': process.platform, 'x-language': 'zh', ...options.headers },
    redirect: 'error', signal: options.signal || AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 401) throw new ApiError(503, 'accio_auth_expired', 'Accio login is no longer valid; refresh or sign in again');
    throw new ApiError(response.status === 429 ? 429 : 502, 'accio_http_error', `Accio returned HTTP ${response.status}`);
  }
  let payload;
  try { payload = await response.json(); }
  catch { throw new ApiError(502, 'accio_invalid_response', 'Accio returned invalid JSON'); }
  if (payload.success === false || (payload.code != null && !['0', '200', 'SUCCESS'].includes(String(payload.code)))) {
    const code = String(payload.code || 'rejected');
    if (['401', 'NOT_LOGIN'].includes(code) || payload.message === 'NOT_LOGIN') {
      throw new ApiError(503, 'accio_auth_expired', 'Accio login is no longer valid; refresh or sign in again');
    }
    throw new ApiError(['401', 'NOT_LOGIN'].includes(code) ? 503 : code === '429' ? 429 : 502,
      'accio_rejected', 'Accio rejected the request');
  }
  return payload.data ?? payload;
}

export class KeychainStore {
  async run(action, payload) {
    return new Promise((resolve, reject) => {
      const windows = process.platform === 'win32';
      const executable = windows ? 'powershell.exe' : '/usr/bin/python3';
      const args = windows
        ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./windows-store.ps1', import.meta.url)), action]
        : ['-B', fileURLToPath(new URL('./keychain.py', import.meta.url)), action];
      const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let output = '', size = 0;
      const timer = setTimeout(() => { child.kill(); reject(new ApiError(503, 'keychain_timeout', 'Bridge credential storage needs attention')); }, 30000);
      child.stdout.on('data', chunk => { size += chunk.length; if (size > 65536) child.kill(); else output += chunk; });
      child.stderr.resume();
      child.on('error', () => { clearTimeout(timer); reject(new ApiError(503, 'keychain_error', 'Unable to open bridge Keychain storage')); });
      child.on('close', code => {
        clearTimeout(timer);
        if (code !== 0 || size > 65536) return reject(new ApiError(503, 'keychain_error', 'Bridge Keychain operation failed'));
        try { resolve(action === 'get' ? JSON.parse(output) : null); }
        catch { reject(new ApiError(503, 'keychain_error', 'Bridge Keychain data is invalid')); }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(payload ? JSON.stringify(payload) : undefined);
    });
  }
  read() { return this.run('get'); }
  write(value) { return this.run('put', value); }
}

export class AccioAuth {
  constructor({ store = new KeychainStore(), fetchImpl = fetch, now = Date.now, readSpace = readOfficialSpace } = {}) {
    this.store = store; this.fetch = fetchImpl; this.now = now;
    this.readSpace = readSpace;
    this.credentials = null; this.pending = null; this.refreshing = null;
    this.installationId = `utd-${now()}-${randomBytes(8).toString('hex')}`;
    this.contextData = null; this.contextPromise = null; this.contextKey = null;
  }
  async init() {
    this.credentials = await this.store.read();
    if (this.credentials?.installationId) this.installationId = this.credentials.installationId;
    else if (this.credentials) {
      this.credentials = { ...this.credentials, installationId: this.installationId };
      await this.store.write(this.credentials);
    }
  }
  headers() {
    return { utdid: this.installationId, 'x-utdid': this.installationId, version: APP_VERSION,
      'x-deploy-target': 'desktop', ...(this.contextData?.routeRegion ? { 'x-accio-route-region': this.contextData.routeRegion } : {}),
      ...(this.contextData?.teamId ? { 'x-team-id': this.contextData.teamId } : {}) };
  }
  async context(signal) {
    await this.token();
    const space = await this.readSpace();
    if (!space || !['team', 'personal'].includes(space.kind) || typeof space.accountId !== 'string' || !space.accountId.trim()
      || (space.kind === 'team' && (typeof space.teamId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(space.teamId)))) {
      throw new ApiError(503, 'official_space_unavailable', 'Open Accio and select a valid space before using the local API');
    }
    const contextKey = JSON.stringify([space.kind, space.accountId, space.teamId ?? null]);
    if (this.contextData && this.contextKey === contextKey) return this.contextData;
    if (this.contextPromise) { await this.contextPromise; return this.context(signal); }
    this.contextData = null; this.contextKey = null;
    this.contextPromise = (async () => {
      const data = await this.withToken(currentToken => upstreamJson('/api/auth/userinfo', { method: 'POST', headers: this.headers(),
        body: JSON.stringify({ accessToken: currentToken, utdid: this.installationId, version: APP_VERSION }), signal }, this.fetch));
      if (![data.userId, data.accioId].some(id => id != null && String(id) === space.accountId)) {
        throw new ApiError(503, 'space_account_mismatch', 'The local API login and the selected Accio space belong to different accounts; sign in to the same account');
      }
      this.contextData = { routeRegion: typeof data.routeRegion === 'string' ? data.routeRegion : undefined,
        teamId: space.kind === 'team' ? space.teamId : undefined };
      this.contextKey = contextKey;
      return this.contextData;
    })().finally(() => { this.contextPromise = null; });
    return this.contextPromise;
  }
  begin(origin) {
    const verifier = randomBytes(48).toString('base64url');
    const state = randomBytes(32).toString('hex');
    const redirectUri = new URL('/auth/callback', origin).href;
    this.pending = { verifier, state, redirectUri, expires: this.now() + 10 * 60 * 1000 };
    const url = new URL('https://www.accio.com/login');
    for (const [key, value] of Object.entries({ return_url: redirectUri, state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256', client_id: 'accio-work' })) url.searchParams.set(key, value);
    return url.href;
  }
  async callback(state, code) {
    const pending = this.pending;
    if (!pending || pending.expires <= this.now() || typeof state !== 'string' || !/^[a-f0-9]{64}$/.test(state) || typeof code !== 'string'
      || !code || code.length > 4096 || state.length !== pending.state.length
      || !timingSafeEqual(Buffer.from(state), Buffer.from(pending.state))) {
      throw new ApiError(400, 'invalid_oauth_callback', 'Invalid or expired OAuth callback');
    }
    this.pending = null;
    const data = await upstreamJson('/api/oauth/token', { method: 'POST', headers: this.headers(), body: JSON.stringify({
      code, codeVerifier: pending.verifier, clientId: 'accio-work', redirectUri: pending.redirectUri, utdid: this.installationId, version: APP_VERSION,
    }) }, this.fetch);
    await this.accept(data);
    this.contextData = null;
    this.contextPromise = null;
    this.contextKey = null;
  }
  async accept(data, preserveCookie = false) {
    if (typeof data.accessToken !== 'string' || !data.accessToken || typeof data.refreshToken !== 'string'
      || !data.refreshToken || !Number.isFinite(data.expiresAt) || data.expiresAt <= 0) {
      throw new ApiError(502, 'invalid_oauth_response', 'Accio login returned an incomplete grant');
    }
    const credentials = { accessToken: data.accessToken, refreshToken: data.refreshToken,
      expiresAt: data.expiresAt * 1000, installationId: this.installationId,
      ...(typeof data.sgcookie === 'string' ? { sgcookie: data.sgcookie } : preserveCookie && this.credentials?.sgcookie ? { sgcookie: this.credentials.sgcookie } : {}) };
    await this.store.write(credentials);
    this.credentials = credentials;
  }
  async token() {
    if (!this.credentials) throw new ApiError(503, 'login_required', 'Run the local API login command first');
    if (this.credentials.expiresAt > this.now() + 45000) return this.credentials.accessToken;
    return this.refreshToken();
  }
  async withToken(operation) {
    const token = await this.token();
    try { return await operation(token); }
    catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'accio_auth_expired') throw error;
      const renewed = await this.refreshToken(token);
      return operation(renewed);
    }
  }
  async refreshToken(rejectedToken) {
    if (!this.credentials) throw new ApiError(503, 'login_required', 'Run the local API login command first');
    // Another request may already have replaced the rejected access token.
    if (rejectedToken && this.credentials.accessToken !== rejectedToken
      && this.credentials.expiresAt > this.now() + 45000) return this.credentials.accessToken;
    if (!this.refreshing) this.refreshing = (async () => {
      const data = await upstreamJson('/api/auth/refresh_token', { method: 'POST', headers: this.headers(), body: JSON.stringify({
        accessToken: this.credentials.accessToken, refreshToken: this.credentials.refreshToken, utdid: this.installationId, version: APP_VERSION,
      }) }, this.fetch);
      await this.accept(data, true);
      this.contextData = null;
      this.contextKey = null;
      return this.credentials.accessToken;
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
}
