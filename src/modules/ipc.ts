import { ipcMain, IpcMainInvokeEvent, shell } from 'electron';
import path from 'path';
import { storeManager } from './store';
import { ServerManager } from './server';
import { TrayManager } from './tray';
import { WindowManager } from './window';
import { SsoManager } from './sso';
import { ApiConfig } from '../types';
import { i18n } from '../i18n';
import { SUPPORTED_LANGUAGES } from '../i18n/languages';
import { assertRendererStoreKey, assertApiRequest } from './security';

export class IpcManager {
  private serverManager: ServerManager;
  private trayManager: TrayManager;
  private windowManager: WindowManager;
  private ssoManager: SsoManager;

  constructor(
    serverManager: ServerManager,
    trayManager: TrayManager,
    windowManager: WindowManager,
    ssoManager: SsoManager
  ) {
    this.serverManager = serverManager;
    this.trayManager = trayManager;
    this.windowManager = windowManager;
    this.ssoManager = ssoManager;
  }

  private handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => any): void {
    ipcMain.handle(channel, (event, ...args) => {
      if (!this.windowManager.isTrustedSender(event)) throw new Error('Untrusted IPC caller');
      return listener(event, ...args);
    });
  }

  private on(channel: string, listener: (event: Electron.IpcMainEvent, ...args: any[]) => void): void {
    ipcMain.on(channel, (event, ...args) => {
      if (this.windowManager.isTrustedSender(event)) listener(event, ...args);
    });
  }

  setupHandlers(): void {
    this.setupStoreHandlers();
    this.setupApiHandlers();
    this.setupTrayHandlers();
    this.setupLocaleHandlers();
    this.setupWindowHandlers();
    this.setupLogsHandlers();
    this.setupAuthHandlers();
  }

  private setupStoreHandlers(): void {
    this.handle('store-get', (_event: IpcMainInvokeEvent, key: string) => {
      assertRendererStoreKey(key);
      return storeManager.get(key);
    });

    this.handle(
      'store-set',
      (_event: IpcMainInvokeEvent, key: string, value: any) => {
        assertRendererStoreKey(key);
        if (typeof value !== 'string' || value.length > 1_000_000) throw new Error('Invalid storage value');
        storeManager.set(key, value);
      }
    );

    this.handle('store-remove', (_event: IpcMainInvokeEvent, key: string) => {
      assertRendererStoreKey(key);
      storeManager.remove(key);
    });
  }

  private setupApiHandlers(): void {
    this.handle(
      'api:get',
      async (_event: IpcMainInvokeEvent, url: string, config: ApiConfig = {}) => {
        assertApiRequest(url, config);
        return await this.serverManager.injectRequest(
          'GET',
          url,
          undefined,
          config?.headers
        );
      }
    );

    this.handle(
      'api:post',
      async (
        _event: IpcMainInvokeEvent,
        url: string,
        data: any = {},
        config: ApiConfig = {}
      ) => {
        assertApiRequest(url, config);
        return await this.serverManager.injectRequest(
          'POST',
          url,
          data,
          config?.headers
        );
      }
    );

    this.handle(
      'api:put',
      async (
        _event: IpcMainInvokeEvent,
        url: string,
        data: any = {},
        config: ApiConfig = {}
      ) => {
        assertApiRequest(url, config);
        return await this.serverManager.injectRequest(
          'PUT',
          url,
          data,
          config?.headers
        );
      }
    );

    this.handle(
      'api:delete',
      async (_event: IpcMainInvokeEvent, url: string, config: ApiConfig = {}) => {
        assertApiRequest(url, config);
        return await this.serverManager.injectRequest(
          'DELETE',
          url,
          undefined,
          config?.headers
        );
      }
    );
  }

  private setupTrayHandlers(): void {
    this.on(
      'update-playing-state',
      (_event, state: { isPlaying: boolean; bookTitle: string } | null) => {
        if (!state || typeof state !== 'object') return;
        const { isPlaying, bookTitle } = state;
        if (typeof isPlaying !== 'boolean' || typeof bookTitle !== 'string') return;
        this.trayManager.updatePlayingState({ isPlaying, bookTitle });
      }
    );

    this.on(
      'update-auth-state',
      (_event, state: { isAuthenticated: boolean } | null) => {
        if (!state || typeof state !== 'object') return;
        const { isAuthenticated } = state;
        if (typeof isAuthenticated !== 'boolean') return;
        this.trayManager.updatePlayingState({ isAuthenticated });
      }
    );
  }

  private setupLocaleHandlers(): void {
    this.handle('get-locale', () => {
      return i18n.getLanguage();
    });

    // Everything the renderer needs to render the picker: the stored mode, the
    // language actually in use, and what 'auto' currently resolves to.
    this.handle('get-locale-state', () => {
      return i18n.getState();
    });

    this.handle('set-locale', async (_event: IpcMainInvokeEvent, locale: string) => {
      if (locale !== 'auto' && !(SUPPORTED_LANGUAGES as readonly string[]).includes(locale)) throw new Error('Invalid locale');
      storeManager.set('appLanguage', locale);

      // Update the current language in i18n
      i18n.detectLanguage();

      // Refresh fastify translations (tray menu, native dialogs) before
      // answering, so the renderer never reads a half-applied state.
      const fastifyServer = this.serverManager.getServer();
      if (fastifyServer) {
        try {
          await i18n.initialize(fastifyServer);
        } catch (err) {
          console.error('Failed to reinitialize i18n:', err);
        }
      }

      // Rebuild the tray menu so its labels follow the new language too.
      this.trayManager.updateMenu();

      return i18n.getState();
    });
  }

  private setupLogsHandlers(): void {
    this.handle('open-logs-folder', () => {
      const logPath = path.join(process.env.USER_DATA_PATH || '', 'app.log');
      shell.showItemInFolder(logPath);
    });
  }

  private setupWindowHandlers(): void {
    this.handle('window-set-always-on-top', (_event: IpcMainInvokeEvent, alwaysOnTop: boolean) => {
      if (typeof alwaysOnTop !== 'boolean') throw new Error('Invalid window setting');
      this.windowManager.setAlwaysOnTop(alwaysOnTop);
    });

    this.handle('window-is-always-on-top', () => {
      return this.windowManager.isAlwaysOnTop();
    });
  }

  private setupAuthHandlers(): void {
    this.handle(
      'auth:open-sso-window',
      async (_event: IpcMainInvokeEvent, provider?: 'google' | 'apple') => {
        if (provider !== undefined && provider !== 'google' && provider !== 'apple') throw new Error('Invalid SSO provider');
        const parent = this.windowManager.getWindow();
        return this.ssoManager.openSsoWindow(parent, provider);
      }
    );
  }
}
