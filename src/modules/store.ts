import ElectronStore from 'electron-store';
import { safeStorage } from 'electron';

// Only these secret values are stored as OS-encrypted base64 blobs. Never expose
// their backing keys through renderer IPC. Without a vault, use memory only.
const SECRET_KEYS = { token: 'protectedToken', signingKey: 'protectedSigningKey' } as const;
type SecretKey = keyof typeof SECRET_KEYS;

export class StoreManager {
  private store: any;
  private transientSecrets = new Map<SecretKey, string>();

  constructor() {
    this.store = new ElectronStore();
  }

  initializeSecurity(): void {
    // Old sessions may contain a reversible password. Require a fresh login.
    this.store.delete('token');
  }

  private hasVault(): boolean {
    return safeStorage.isEncryptionAvailable() &&
      !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text');
  }

  getSecret(key: SecretKey): string | undefined {
    const transient = this.transientSecrets.get(key);
    if (transient !== undefined) return transient;
    const encrypted = this.store.get(SECRET_KEYS[key]);
    if (!encrypted || !this.hasVault()) return undefined;
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    } catch {
      // A damaged blob or a different OS user must sign in again.
      this.store.delete(SECRET_KEYS[key]);
      return undefined;
    }
  }

  setSecret(key: SecretKey, value: string): void {
    this.store.delete(SECRET_KEYS[key]);
    this.transientSecrets.delete(key);
    if (this.hasVault()) {
      this.store.set(SECRET_KEYS[key], safeStorage.encryptString(value).toString('base64'));
    } else {
      this.transientSecrets.set(key, value);
    }
  }

  get<T = any>(key: string): T | undefined {
    if (key === 'token') return this.getSecret('token') as T | undefined;
    return this.store.get(key) as T | undefined;
  }

  set<T = any>(key: string, value: T): void {
    if (key === 'token') {
      if (typeof value !== 'string') throw new Error('Invalid session');
      this.setSecret('token', value);
      return;
    }
    this.store.set(key, value);
  }

  remove(key: string): void {
    if (key === 'token') {
      this.transientSecrets.delete('token');
      this.store.delete(SECRET_KEYS.token);
    }
    this.store.delete(key);
  }

  clear(): void {
    this.transientSecrets.clear();
    this.store.clear();
  }
}

export const storeManager = new StoreManager();
