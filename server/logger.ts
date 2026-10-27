import fs from 'fs';
import path from 'path';

export interface LogEntry {
  id: string;
  timestamp: string;
  type: 'http_request' | 'http_response' | 'error' | 'action';
  message: string;
  method?: string;
  url?: string;
  status?: number;
  data?: any;
}

const ACTIONS = new Set([
  'User attempted SSO login', 'User attempted login',
  'User initiated download', 'User cancelled download', 'User deleted downloaded book',
  'create_bookmark', 'delete_bookmark', 'edit_bookmark',
  'skip_forward', 'skip_backward', 'play', 'pause',
]);

function diagnosticUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    // Never retain userinfo, query parameters (including playback links), or fragments.
    return `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
}

function sanitize(entry: Partial<LogEntry>): LogEntry {
  const type = ['http_request', 'http_response', 'error', 'action'].includes(entry.type || '')
    ? entry.type! : 'action';
  const method = typeof entry.method === 'string' && /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(entry.method)
    ? entry.method : undefined;
  const status = Number.isInteger(entry.status) && entry.status! >= 100 && entry.status! <= 599
    ? entry.status : undefined;
  const url = diagnosticUrl(entry.url);
  // Payloads and free-form errors can contain arbitrary credential encodings.
  // Keep a small diagnostic allowlist rather than trying to recognize every secret.
  const message = type === 'action'
    ? (ACTIONS.has(entry.message || '') ? entry.message! : 'User action')
    : `${type === 'error' ? 'Request failed' : 'HTTP'}${method ? ` ${method}` : ''}${status ? ` ${status}` : ''}${url ? ` ${url}` : ''}`;
  return {
    id: typeof entry.id === 'string' && /^[a-z0-9]{1,32}$/.test(entry.id)
      ? entry.id : Math.random().toString(36).substring(2, 9),
    timestamp: typeof entry.timestamp === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(entry.timestamp)
      ? entry.timestamp : new Date().toISOString(),
    type, message, ...(method && { method }), ...(status && { status }), ...(url && { url }),
  };
}

export class Logger {
  private logs: LogEntry[] = [];
  private readonly MAX_LOGS = 1000;
  private readonly MAX_FILE_SIZE = 10 * 1024 * 1024;
  private readonly MAX_FILES = 5;
  private readonly LOG_DIR: string;
  private readonly LOG_FILE_PATH: string;

  constructor(logDir = process.env.USER_DATA_PATH || process.cwd()) {
    this.LOG_DIR = logDir;
    this.LOG_FILE_PATH = path.join(logDir, 'app.log');
    // Desktop diagnostic export opens this directory, including all archives.
    // Fail startup on an I/O error rather than silently leaving old secrets behind.
    for (let i = 0; i < this.MAX_FILES; i++) {
      const file = i === 0 ? this.LOG_FILE_PATH : this.getArchivedFilePath(i);
      if (!fs.existsSync(file)) continue;
      let entries: unknown;
      try {
        entries = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        fs.unlinkSync(file);
        continue;
      }
      const safe = Array.isArray(entries)
        ? entries.filter((entry) => entry && typeof entry === 'object').slice(0, this.MAX_LOGS).map(sanitize)
        : [];
      fs.writeFileSync(file, JSON.stringify(safe, null, 2), { mode: 0o600 });
      if (i === 0) this.logs = safe;
    }
  }

  private getArchivedFilePath(index: number): string {
    return path.join(this.LOG_DIR, `app.${index}.log`);
  }

  private rotate(): void {
    const oldest = this.getArchivedFilePath(this.MAX_FILES - 1);
    if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
    for (let i = this.MAX_FILES - 2; i >= 1; i--) {
      const source = this.getArchivedFilePath(i);
      if (fs.existsSync(source)) fs.renameSync(source, this.getArchivedFilePath(i + 1));
    }
    if (fs.existsSync(this.LOG_FILE_PATH)) {
      fs.renameSync(this.LOG_FILE_PATH, this.getArchivedFilePath(1));
    }
    this.logs = [];
  }

  private saveToFile(): void {
    try {
      fs.writeFileSync(this.LOG_FILE_PATH, JSON.stringify(this.logs, null, 2), { mode: 0o600 });
      if (fs.statSync(this.LOG_FILE_PATH).size > this.MAX_FILE_SIZE) {
        this.rotate();
        fs.writeFileSync(this.LOG_FILE_PATH, '[]', { mode: 0o600 });
      }
    } catch {
      console.error('Failed to save diagnostic logs');
    }
  }

  add(entry: Omit<LogEntry, 'id' | 'timestamp'>): void {
    // Snapshot the allowed scalars; caller-owned request/response data is untouched.
    this.logs.unshift(sanitize(entry));
    this.logs = this.logs.slice(0, this.MAX_LOGS);
    setImmediate(() => this.saveToFile());
  }

  getLogs(): LogEntry[] {
    return this.logs.map(sanitize);
  }

  clearLogs(): void {
    this.logs = [];
    for (let i = 1; i < this.MAX_FILES; i++) {
      const file = this.getArchivedFilePath(i);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    this.saveToFile();
  }
}

export const appLogger = new Logger();
