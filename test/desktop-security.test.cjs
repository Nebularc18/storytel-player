const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const ts = require('typescript');
const { pathToFileURL } = require('node:url');

function load(relative, mocks = {}, extra = {}) {
  const filename = path.resolve(__dirname, '..', relative);
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports, URL, require: (name) => mocks[name] ?? require(name), Buffer, console, process,
    __dirname: path.resolve(__dirname, '../dist/electron', path.dirname(relative).slice(4)), ...extra,
  }, { filename });
  return exports;
}

const security = load('src/modules/security.ts');
const documentUrl = pathToFileURL(path.resolve(__dirname, '../client/build/index.html')).href;

test('only the app main frame can use privileged IPC', () => {
  const frame = { url: documentUrl };
  const contents = { mainFrame: frame, isDestroyed: () => false };
  const event = { sender: contents, senderFrame: frame };
  assert.equal(security.isTrustedCaller(event, contents, false), true);
  assert.equal(security.isTrustedCaller({ ...event, sender: {} }, contents, false), false);
  assert.equal(security.isTrustedCaller({ ...event, senderFrame: { url: documentUrl } }, contents, false), false);
  for (const url of ['https://www.storytel.com/', documentUrl + '?remote=1', 'file:///tmp/index.html', 'http://localhost:3000.evil.test/']) {
    frame.url = url;
    assert.equal(security.isTrustedCaller(event, contents, false), false);
  }
  frame.url = 'http://localhost:3000/';
  assert.equal(security.isTrustedCaller(event, contents, true), true);
  assert.equal(security.isTrustedCaller(event, contents, false), false);
});

test('renderer store and API boundaries reject root aliases and remote URLs', () => {
  for (const key of ['', 'protectedToken', 'protectedSigningKey', '__proto__', 'token.x', 'settings', 'appLanguage', 'pos:../x']) {
    assert.throws(() => security.assertRendererStoreKey(key));
  }
  for (const key of ['token', 'hasSeenWelcome', 'searchLanguageFilter', 'last_played_session', 'pos:123']) {
    security.assertRendererStoreKey(key);
  }
  for (const url of ['https://evil.test/api/logs', '//evil.test', '/api/../logs', '/api/\\evil', 'file:///tmp/test']) {
    assert.throws(() => security.assertApiRequest(url, {}));
  }
  security.assertApiRequest('/api/search?q=hello%20world', { headers: { Authorization: 'Bearer fixture' } });
  assert.throws(() => security.assertApiRequest('/api/account', { headers: { host: 'evil.test' } }));
});

test('SSO allows provider flows and rejects deceptive hosts and unsafe schemes', () => {
  for (const url of ['https://www.storytel.com/it/login', 'https://accounts.google.com/login', 'https://appleid.apple.com/auth', 'https://storytel.firebaseapp.com/__/auth/handler']) {
    assert.equal(security.isSsoUrl(url), true, url);
  }
  for (const url of ['https://evilstorytel.com/', 'https://storytel.com.evil.test/', 'http://www.storytel.com/', 'file:///tmp/index.html', 'https://user@www.storytel.com/', 'https://evil.firebaseapp.com/other', 'https://accounts.google.com:9000/']) {
    assert.equal(security.isSsoUrl(url), false, url);
  }
});

test('saved sessions are encrypted, survive a store restart and disappear on logout', () => {
  const disk = new Map([['token', 'legacy-password-bearing-session']]);
  class Store {
    get(key) { return disk.get(key); }
    set(key, value) { disk.set(key, value); }
    delete(key) { disk.delete(key); }
    clear() { disk.clear(); }
  }
  const key = crypto.randomBytes(32);
  let available = true;
  let backend = 'gnome_libsecret';
  const safeStorage = {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString(value) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const bytes = Buffer.concat([cipher.update(value), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
    },
    decryptString(value) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString();
    },
  };
  const { StoreManager } = load('src/modules/store.ts', { 'electron-store': Store, electron: { safeStorage } }, { process: { platform: 'linux' } });
  const first = new StoreManager();
  first.initializeSecurity();
  assert.equal(disk.has('token'), false);
  first.set('token', 'private-session-fixture');
  first.setSecret('signingKey', 'private-signing-key-fixture');
  assert.equal(JSON.stringify([...disk]).includes('private-'), false);
  const restarted = new StoreManager();
  restarted.initializeSecurity();
  assert.equal(restarted.get('token'), 'private-session-fixture');
  assert.equal(restarted.getSecret('signingKey'), 'private-signing-key-fixture');
  restarted.remove('token');
  assert.equal(new StoreManager().get('token'), undefined);
  for (const mode of ['unavailable', 'basic_text']) {
    available = mode !== 'unavailable';
    backend = mode === 'basic_text' ? mode : 'gnome_libsecret';
    restarted.set('token', 'memory-only-fixture');
    assert.equal(disk.has('protectedToken'), false);
    assert.equal(restarted.get('token'), 'memory-only-fixture');
    assert.equal(new StoreManager().get('token'), undefined);
    restarted.remove('token');
  }
  available = true;
  backend = 'gnome_libsecret';
  disk.set('protectedToken', 'corrupted-ciphertext');
  assert.equal(restarted.get('token'), undefined);
  assert.equal(disk.has('protectedToken'), false);
});

test('every registered IPC handler rejects an untrusted caller before side effects', async () => {
  const handles = new Map();
  const events = new Map();
  const calls = [];
  const storeManager = { get: (...args) => calls.push(args), set: (...args) => calls.push(args), remove: (...args) => calls.push(args) };
  const { IpcManager } = load('src/modules/ipc.ts', {
    electron: { ipcMain: { handle: (name, cb) => handles.set(name, cb), on: (name, cb) => events.set(name, cb) }, shell: { showItemInFolder: () => calls.push('shell') } },
    './store': { storeManager }, './security': security,
    '../i18n/languages': { SUPPORTED_LANGUAGES: ['en'] },
    '../i18n': { i18n: { getLanguage: () => calls.push('locale'), getState: () => calls.push('state') } },
  });
  const manager = new IpcManager({ injectRequest: () => calls.push('api') },
    { updatePlayingState: () => calls.push('tray') },
    { isTrustedSender: (event) => event.trusted, setAlwaysOnTop: () => calls.push('window'), isAlwaysOnTop: () => calls.push('window') },
    { openSsoWindow: () => calls.push('sso') });
  manager.setupHandlers();
  assert.equal(handles.size, 14);
  for (const [channel, cb] of handles) {
    assert.throws(() => cb({ trusted: false }, 'token', 'fixture'), /Untrusted IPC caller/, channel);
  }
  for (const cb of events.values()) cb({ trusted: false }, { isPlaying: true, isAuthenticated: true, bookTitle: 'fixture' });
  assert.equal(calls.length, 0);
  handles.get('store-set')({ trusted: true }, 'token', 'fixture');
  assert.equal(calls.length, 1);
  assert.throws(() => handles.get('store-get')({ trusted: true }, 'protectedSigningKey'));
  assert.throws(() => handles.get('store-get')({ trusted: true }, ''));
  assert.equal(calls.length, 1);
});

test('community links open externally only for the fixed destinations', () => {
  assert.equal(security.isExternalLink('https://github.com/debba/storytel-player'), true);
  assert.equal(security.isExternalLink('https://discord.gg/YrZPHAwMSG'), true);
  for (const url of ['https://github.com.evil.test/debba/storytel-player', 'file:///tmp/run.exe', 'https://github.com/debba/storytel-player?redirect=evil', 'https://evil.test']) {
    assert.equal(security.isExternalLink(url), false);
  }
});

test('browser sessions purge old localStorage tokens and persist only in memory', async () => {
  const disk = new Map([['token', 'old-password-bearing-session'], ['hasSeenWelcome', 'true']]);
  const localStorage = {
    getItem: (key) => disk.get(key), setItem: (key, value) => disk.set(key, value),
    removeItem: (key) => disk.delete(key),
  };
  const loadStorage = () => load('client/src/utils/storage.ts', {}, { window: {}, localStorage }).default;
  const first = loadStorage();
  assert.equal(disk.has('token'), false);
  await first.set('token', 'new-private-session');
  assert.equal(await first.get('token'), 'new-private-session');
  assert.equal(disk.has('token'), false);
  assert.equal(await first.get('hasSeenWelcome'), 'true');
  assert.equal(await loadStorage().get('token'), undefined);
  await first.remove('token');
  assert.equal(await first.get('token'), undefined);
});
