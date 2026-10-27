// Runs against the built Electron application code, never a real account.
const { app, BrowserWindow, safeStorage } = require('electron');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const [stage, directory] = process.argv.slice(2);
if (!['prepare', 'restart'].includes(stage) || !directory) throw new Error('Stage and isolated userData directory required');
fs.mkdirSync(path.resolve(directory), { recursive: true });
app.setPath('userData', path.resolve(directory));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const timeout = setTimeout(() => { console.error('Desktop smoke test timed out'); app.exit(1); }, 60000);
app.whenReady().then(async () => {
  assert.equal(process.platform, 'win32', 'This test validates Windows DPAPI');
  assert.equal(safeStorage.isEncryptionAvailable(), true);
  process.env.IS_ELECTRON = 'true';
  process.env.USER_DATA_PATH = path.resolve(directory);
  process.env.DOWNLOAD_PATH = path.resolve(directory, 'downloads');
  fs.mkdirSync(process.env.DOWNLOAD_PATH, { recursive: true });
  const { storeManager } = require('../dist/electron/modules/store.js');
  storeManager.initializeSecurity();
  if (stage === 'prepare') {
    const key = crypto.randomBytes(32).toString('hex');
    storeManager.setSecret('signingKey', key);
    process.env.JWT_SECRET = key;
    const server = require('../server/dist/server.js').default;
    await server.ready();
    storeManager.set('token', server.jwt.sign({ authVersion: 3, email: 'offline@example.test', storytelToken: '', jwt: '' }));
    storeManager.set('pos:123', JSON.stringify({ position: 0.5 }));
    const disk = fs.readFileSync(path.join(directory, 'config.json'), 'utf8');
    assert.equal(disk.includes(key), false);
    assert.equal(disk.includes('offline@example.test'), false);
    assert.equal(disk.includes(storeManager.get('token')), false);
    await server.close();
  } else {
    const token = storeManager.get('token');
    assert.equal(typeof token, 'string');
    const signingKey = storeManager.getSecret('signingKey');
    assert.match(signingKey, /^[a-f0-9]{64}$/);
    process.env.JWT_SECRET = signingKey;
    const { ServerManager } = require('../dist/electron/modules/server.js');
    const { WindowManager } = require('../dist/electron/modules/window.js');
    const { IpcManager } = require('../dist/electron/modules/ipc.js');
    const serverManager = new ServerManager();
    await serverManager.initialize();
    const server = serverManager.getServer();
    await server.ready();
    // No account traffic is possible during this offline test.
    app.on('web-contents-created', (_event, contents) => {
      contents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
    });
    const manager = new WindowManager(false, false);
    const win = manager.create();
    new IpcManager(serverManager, { updatePlayingState() {}, updateMenu() {} }, manager, { openSsoWindow() { throw new Error('Unexpected SSO'); } }).setupHandlers();
    // Open logged out to avoid fetching the online bookshelf in the actual UI.
    storeManager.remove('token');
    await once(win.webContents, 'did-finish-load');
    assert.equal(win.webContents.getLastWebPreferences().sandbox, true);
    assert.equal(win.webContents.getLastWebPreferences().nodeIntegration, false);
    const capabilities = await win.webContents.executeJavaScript(`({ node: typeof require, bridge: typeof window.electronApi?.get, popup: window.open('https://example.com') === null })`);
    assert.deepEqual(capabilities, { node: 'undefined', bridge: 'function', popup: true });
    await win.webContents.executeJavaScript(`window.electronStore.set('token', ${JSON.stringify(token)})`);
    const status = await win.webContents.executeJavaScript(`(async () => {
      const token = await window.electronStore.get('token');
      return window.electronApi.get('/api/auth/status', null, {headers: {Authorization: 'Bearer ' + token}});
    })()`);
    assert.equal(status.data.authenticated, true);
    assert.equal(JSON.parse(storeManager.get('pos:123')).position, 0.5);
    const denied = await win.webContents.executeJavaScript(`window.electronStore.get('protectedSigningKey').then(() => false, () => true)`);
    assert.equal(denied, true);
    const stranger = new BrowserWindow({ show: false, webPreferences: { preload: path.resolve(__dirname, '../dist/electron/preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await stranger.loadFile(path.resolve(__dirname, '../client/build/index.html'));
    assert.equal(await stranger.webContents.executeJavaScript(`window.electronStore.get('token').then(() => false, () => true)`), true);
    stranger.destroy();
    // A small PCM WAV fixture exercises native file playback and seeking.
    const data = Buffer.alloc(44 + 16000 * 2 * 2);
    data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
    data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
    data.writeUInt32LE(16000, 24); data.writeUInt32LE(32000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
    data.write('data', 36); data.writeUInt32LE(data.length - 44, 40);
    fs.writeFileSync(path.join(process.env.DOWNLOAD_PATH, '123.mp3'), data);
    const stream = await serverManager.injectRequest('POST', '/api/stream', { bookId: '123' }, { authorization: `Bearer ${token}` });
    assert.equal(stream.data.remote, false);
    const audio = await win.webContents.executeJavaScript(`(async () => {
      const audio = new Audio(${JSON.stringify(stream.data.streamUrl)});
      await new Promise((resolve, reject) => { audio.onloadedmetadata = resolve; audio.onerror = () => reject(new Error('Media load failed')); });
      await audio.play();
      await new Promise(resolve => { audio.onseeked = resolve; audio.currentTime = 1; });
      audio.pause();
      return {duration: audio.duration, position: audio.currentTime};
    })()`);
    assert.equal(audio.duration, 2);
    assert.ok(audio.position >= 1);
    await win.webContents.executeJavaScript(`window.electronStore.remove('token')`);
    assert.equal(storeManager.get('token'), undefined);
    assert.equal(fs.readFileSync(path.join(directory, 'config.json'), 'utf8').includes('protectedToken'), false);
    win.destroy();
    await server.close();
  }
  console.log(`Windows desktop ${stage} checks passed`);
  clearTimeout(timeout);
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
