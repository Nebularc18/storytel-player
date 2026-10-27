const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'storytel-security-'));
process.env.USER_DATA_PATH = directory;
process.env.DOWNLOAD_PATH = directory;
process.env.IS_ELECTRON = 'test'; // Use temporary downloads, exercise browser URLs.
process.env.NODE_ENV = 'production';
delete process.env.JWT_SECRET;

const axios = require('axios').default;
let upstreamCalls = 0;
let invalidSnapshot = false;
const upstreamJwt = `header.${Buffer.from(JSON.stringify({ exp: 4102444800 })).toString('base64url')}.signature`;
axios.defaults.adapter = async (config) => {
  upstreamCalls++;
  const response = (data, status = 200) => ({ data, status, statusText: 'fixture', headers: {}, config });
  const deny = () => {
    throw new axios.AxiosError('UPSTREAM_PRIVATE_SENTINEL', 'ERR_BAD_REQUEST', config, undefined, response({}, 401));
  };
  if (config.url.startsWith('https://securetoken.googleapis.com/v1/token?')) {
    const refresh = new URLSearchParams(config.data).get('refresh_token');
    if (refresh?.startsWith('valid')) return response({ id_token: 'storytel-bearer', expires_in: '3600' });
    if (refresh === 'foreign-project') return response({ id_token: 'foreign-bearer', expires_in: '3600' });
    return deny();
  }
  if (config.url === 'https://api.storytel.net/libraries/bookshelf') {
    if (config.headers.get('Authorization') !== 'Bearer storytel-bearer') return deny();
    assert.equal(config.data, ''); // Preserve the upstream form-body contract.
    return response(invalidSnapshot ? { error: 'invalid' } : { items: {}, resourceVersion: '1' });
  }
  if (config.url === 'https://www.storytel.com/api/login.action') {
    return response({ accountInfo: { jwt: upstreamJwt, singleSignToken: 'LOGIN_TOKEN_SENTINEL' } });
  }
  throw new Error(`Unexpected upstream request in test: ${config.url}`);
};

const server = require('../fastify-common.ts').default;
const { Logger, appLogger } = require('../logger.ts');
const { createMediaAccess, verifyMediaAccess } = require('../mediaAccess.ts');
const { resolveJwtSecret } = require('../authSecret.ts');
const sso = (refresh = 'valid') => ({
  storytelSession: 'SESSION_SENTINEL', firebaseRefreshToken: refresh, firebaseApiKey: 'fixture-key', email: 'listener@example.test',
});
let session;
after(async () => {
  await server.close();
  await new Promise((resolve) => setImmediate(resolve));
  fs.rmSync(directory, { recursive: true, force: true });
});

test('fake SSO credentials cannot mint an app token or expose upstream errors', async () => {
  const response = await server.inject({ method: 'POST', url: '/api/sso-login', payload: sso('dummy') });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().token, undefined);
  assert.equal(response.body.includes('UPSTREAM_PRIVATE_SENTINEL'), false);
});

test('malformed SSO fields are rejected before contacting either identity service', async () => {
  for (const value of [42, {}, [], '', '   ', null]) {
    const before = upstreamCalls;
    const response = await server.inject({ method: 'POST', url: '/api/sso-login', payload: { ...sso(), firebaseRefreshToken: value } });
    assert.equal(response.statusCode, 400);
    assert.equal(upstreamCalls, before);
  }
});

test('a successful refresh from an unrelated Firebase project is insufficient', async () => {
  const response = await server.inject({ method: 'POST', url: '/api/sso-login', payload: sso('foreign-project') });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().token, undefined);
});

test('an invalid successful HTTP response from Storytel cannot verify SSO', async () => {
  invalidSnapshot = true;
  try {
    const response = await server.inject({ method: 'POST', url: '/api/sso-login', payload: sso('valid-invalid-snapshot') });
    assert.equal(response.statusCode, 401);
  } finally { invalidSnapshot = false; }
});

test('verified SSO with an empty bookshelf still signs in', async () => {
  const response = await server.inject({ method: 'POST', url: '/api/sso-login', payload: sso('valid-empty') });
  assert.equal(response.statusCode, 200);
  session = response.json().token;
  const account = await server.inject({ method: 'GET', url: '/api/account', headers: { authorization: `Bearer ${session}` } });
  assert.equal(account.statusCode, 200);
  assert.equal(account.json().email, 'listener@example.test');
});

test('legacy password login remains usable without logging its response credentials', async () => {
  const response = await server.inject({ method: 'POST', url: '/api/login', payload: { email: 'listener@example.test', password: 'test-password' } });
  assert.equal(response.statusCode, 200);
  const logs = await server.inject({ method: 'GET', url: '/api/logs/export', headers: { authorization: `Bearer ${response.json().token}` } });
  assert.equal(logs.statusCode, 200);
  assert.equal(logs.body.includes('LOGIN_TOKEN_SENTINEL'), false);
  assert.equal(logs.body.includes(upstreamJwt), false);
  assert.equal(logs.body.includes('test-password'), false);
});

test('pre-fix app sessions are rejected by account APIs and auth status', async () => {
  const old = server.jwt.sign({ email: 'old@example.test', ssoStorytelSession: 'dummy' });
  const headers = { authorization: `Bearer ${old}` };
  assert.equal((await server.inject({ method: 'GET', url: '/api/logs', headers })).statusCode, 401);
  assert.equal((await server.inject({ method: 'GET', url: '/api/auth/status', headers })).json().authenticated, false);
});

test('the old public default signing key cannot forge a new session', async () => {
  const encoded = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${encoded({ alg: 'HS256', typ: 'JWT' })}.${encoded({ authVersion: 2, email: 'attacker@example.test' })}`;
  const signature = crypto.createHmac('sha256', 'your-super-secret-jwt-key-change-this-in-production').update(input).digest('base64url');
  const response = await server.inject({ method: 'GET', url: '/api/logs', headers: { authorization: `Bearer ${input}.${signature}` } });
  assert.equal(response.statusCode, 401);
});

test('desktop session keys survive a process restart and remain installation-specific', () => {
  const first = fs.mkdtempSync(path.join(directory, 'install-one-'));
  const second = fs.mkdtempSync(path.join(directory, 'install-two-'));
  const environment = { IS_ELECTRON: 'true', USER_DATA_PATH: first };
  const key = resolveJwtSecret(environment);
  const jwt = require('fast-jwt');
  const token = jwt.createSigner({ key })({ authVersion: 2, email: 'offline@example.test' });
  // Load the helper in a separate process, as a fresh Electron main would.
  const { execFileSync } = require('node:child_process');
  const restartedKey = execFileSync(process.execPath, ['--import', 'tsx', '-e',
    'process.stdout.write(require("./authSecret.ts").resolveJwtSecret())'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, IS_ELECTRON: 'true', USER_DATA_PATH: first }, encoding: 'utf8',
  });
  assert.equal(restartedKey, key);
  assert.equal(jwt.createVerifier({ key: restartedKey })(token).email, 'offline@example.test');
  assert.notEqual(resolveJwtSecret({ IS_ELECTRON: 'true', USER_DATA_PATH: second }), key);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(first, '.session-signing-key')).mode & 0o777, 0o600);
  }
  assert.throws(() => resolveJwtSecret({ JWT_SECRET: 'your-super-secret-jwt-key-change-this-in-production' }));
  assert.throws(() => resolveJwtSecret({ JWT_SECRET: 'short' }));
  assert.notEqual(resolveJwtSecret({}), resolveJwtSecret({}));
  const configured = 'test-configured-secret-with-at-least-32-characters';
  assert.equal(resolveJwtSecret({ JWT_SECRET: configured }), configured);
});

test('diagnostics omit encoded, nested and free-form credential payloads without mutating callers', async () => {
  const logDir = fs.mkdtempSync(path.join(directory, 'logger-'));
  const logger = new Logger(logDir);
  const payload = { accountInfo: { jwt: 'NESTED_SENTINEL' }, form: 'refresh_token=FORM_SENTINEL', serialized: '{"token":"JSON_SENTINEL"}' };
  const entry = { type: 'http_response', method: 'GET', status: 200,
    message: 'https://www.storytel.com/api/login.action?token=MESSAGE_SENTINEL',
    url: 'https://USER_SENTINEL:PASS_SENTINEL@www.storytel.com/api/login.action?%74oken=URL_SENTINEL#FRAGMENT_SENTINEL', data: payload };
  logger.add(entry);
  payload.later = 'MUTATION_SENTINEL';
  logger.add({ type: 'error', message: 'ERROR_SENTINEL', data: 'refresh_token=ERROR_BODY_SENTINEL' });
  logger.add({ type: 'action', message: 'ACTION_SENTINEL', data: { token: 'ACTION_BODY_SENTINEL' } });
  await new Promise((resolve) => setImmediate(resolve));
  const disk = fs.readFileSync(path.join(logDir, 'app.log'), 'utf8');
  assert.equal(disk.includes('SENTINEL'), false);
  assert.equal(JSON.stringify(logger.getLogs()).includes('SENTINEL'), false);
  assert.equal(payload.accountInfo.jwt, 'NESTED_SENTINEL');
  assert.equal(entry.url.includes('URL_SENTINEL'), true);
  assert.equal(logger.getLogs()[2].url, 'https://www.storytel.com/api/login.action');
  assert.equal(logger.getLogs()[2].status, 200);
  const exported = logger.getLogs(); exported[2].message = 'EXTERNAL_SENTINEL';
  assert.equal(JSON.stringify(logger.getLogs()).includes('SENTINEL'), false);
});

test('all historical archives are scrubbed before exposure and clear removes archives', () => {
  const logDir = fs.mkdtempSync(path.join(directory, 'migration-'));
  const files = ['app.log', 'app.1.log', 'app.2.log', 'app.3.log', 'app.4.log'];
  for (const file of files) fs.writeFileSync(path.join(logDir, file), JSON.stringify([
    { type: 'http_response', message: 'OLD_SENTINEL', url: 'https://www.storytel.com/api?token=OLD_QUERY_SENTINEL', data: { jwt: 'OLD_BODY_SENTINEL' } },
  ]));
  const logger = new Logger(logDir);
  for (const file of files) assert.equal(fs.readFileSync(path.join(logDir, file), 'utf8').includes('SENTINEL'), false);
  assert.equal(logger.getLogs()[0].url, 'https://www.storytel.com/api');
  logger.clearLogs();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(logDir, 'app.log'), 'utf8')), []);
  for (const file of files.slice(1)) assert.equal(fs.existsSync(path.join(logDir, file)), false);
});

test('malformed historical logs are removed rather than left readable', () => {
  const logDir = fs.mkdtempSync(path.join(directory, 'corrupt-'));
  fs.writeFileSync(path.join(logDir, 'app.1.log'), 'BROKEN_SECRET_SENTINEL');
  new Logger(logDir);
  assert.equal(fs.existsSync(path.join(logDir, 'app.1.log')), false);
});

test('media capabilities reject wrong book, tampering, expiration and future lifetimes', () => {
  const now = Date.now(); const capability = createMediaAccess('123', now);
  assert.equal(verifyMediaAccess('123', capability, now), true);
  assert.equal(verifyMediaAccess('124', capability, now), false);
  assert.equal(verifyMediaAccess('123', `${capability.slice(0, -1)}!`, now), false);
  assert.equal(verifyMediaAccess('123', capability, now + 24 * 60 * 60 * 1000), false);
  assert.equal(verifyMediaAccess('123', createMediaAccess('123', now + 100000), now), false);
});

test('anonymous media requests fail while native playback links support full and partial audio', async () => {
  fs.writeFileSync(path.join(directory, '123.mp3'), '0123456789');
  for (const url of ['/api/local-stream/123', '/api/local-stream/999']) {
    assert.equal((await server.inject({ method: 'GET', url })).statusCode, 401);
  }
  const response = await server.inject({ method: 'POST', url: '/api/stream', headers: { authorization: `Bearer ${session}` }, payload: { bookId: '123' } });
  assert.equal(response.statusCode, 200);
  const mediaUrl = new URL(response.json().streamUrl);
  assert.equal(mediaUrl.search.includes(session), false);
  const route = `${mediaUrl.pathname}${mediaUrl.search}`;
  const full = await server.inject({ method: 'GET', url: route });
  assert.equal(full.statusCode, 200); assert.equal(full.body, '0123456789');
  for (const [range, expected] of [['bytes=2-5', '2345'], ['bytes=7-', '789']]) {
    const partial = await server.inject({ method: 'GET', url: route, headers: { range } });
    assert.equal(partial.statusCode, 206); assert.equal(partial.body, expected);
    assert.equal(partial.headers['content-length'], String(expected.length));
    assert.equal(partial.headers['accept-ranges'], 'bytes');
  }
  for (const range of ['garbage', 'bytes=-1-3', 'bytes=5-2', 'bytes=10-', 'bytes=0-999', 'bytes=0-1,4-5']) {
    assert.equal((await server.inject({ method: 'GET', url: route, headers: { range } })).statusCode, 416);
  }
  const access = mediaUrl.searchParams.get('access');
  assert.equal((await server.inject({ method: 'GET', url: `/api/local-stream/124?access=${access}` })).statusCode, 401);
  assert.equal((await server.inject({ method: 'GET', url: '/api/logs', headers: { authorization: `Bearer ${access}` } })).statusCode, 401);
});

test('Electron offline playback still returns the local file URL', async () => {
  process.env.IS_ELECTRON = 'true';
  try {
    const response = await server.inject({ method: 'POST', url: '/api/stream', headers: { authorization: `Bearer ${session}` }, payload: { bookId: '123' } });
    assert.equal(response.statusCode, 200);
    assert.equal(new URL(response.json().streamUrl).protocol, 'file:');
  } finally { process.env.IS_ELECTRON = 'test'; }
});

test('HTTP log exports cannot disclose injected payload credentials', async () => {
  appLogger.add({ type: 'http_request', message: 'token=EXPORT_SENTINEL', url: 'https://www.storytel.com/api?token=EXPORT_SENTINEL', data: { token: 'EXPORT_SENTINEL' } });
  const response = await server.inject({ method: 'GET', url: '/api/logs/export', headers: { authorization: `Bearer ${session}` } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.includes('EXPORT_SENTINEL'), false);
});
