import { pathToFileURL } from 'url';
import path from 'path';

export function isAppUrl(url: string, isDev: boolean): boolean {
  try {
    const parsed = new URL(url);
    if (isDev) return parsed.origin === 'http://localhost:3000' && !parsed.username && !parsed.password;
    const expected = pathToFileURL(path.join(__dirname, '../../../client/build/index.html'));
    return parsed.protocol === 'file:' && parsed.host === expected.host &&
      parsed.pathname === expected.pathname && !parsed.search;
  } catch { return false; }
}

export function isTrustedCaller(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent,
  contents: Electron.WebContents | undefined, isDev: boolean): boolean {
  return !!contents && !contents.isDestroyed() && event.sender === contents &&
    !!event.senderFrame && event.senderFrame === contents.mainFrame &&
    isAppUrl(event.senderFrame.url, isDev);
}

export function assertRendererStoreKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' ||
    (!['token', 'hasSeenWelcome', 'searchLanguageFilter', 'last_played_session'].includes(key) &&
      !/^pos:[0-9]+$/.test(key))) throw new Error('Invalid storage key');
}

export function assertApiRequest(url: unknown, config: unknown): void {
  if (typeof url !== 'string' || !/^\/api\/[a-zA-Z0-9/_-]+(?:\?[^#\s\\]*)?$/.test(url)) {
    throw new Error('Invalid API path');
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid API configuration');
  const headers = (config as { headers?: unknown }).headers;
  if (headers !== undefined && (!headers || typeof headers !== 'object' || Array.isArray(headers) ||
    !Object.entries(headers).every(([key, value]) =>
      ['authorization', 'content-type', 'accept'].includes(key.toLowerCase()) && typeof value === 'string'))) {
    throw new Error('Invalid API headers');
  }
}

export function isSsoUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return false;
    const host = parsed.hostname;
    return host === 'storytel.com' || host.endsWith('.storytel.com') ||
      host === 'accounts.google.com' || host === 'appleid.apple.com' ||
      (host.endsWith('.firebaseapp.com') && parsed.pathname.startsWith('/__/auth/'));
  } catch { return false; }
}

export function isExternalLink(url: string): boolean {
  return [
    'https://github.com/debba/storytel-player',
    'https://discord.gg/YrZPHAwMSG',
  ].includes(url);
}
