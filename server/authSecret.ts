import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

interface AuthEnvironment {
  JWT_SECRET?: string;
  IS_ELECTRON?: string;
  USER_DATA_PATH?: string;
}

export function resolveJwtSecret(environment: AuthEnvironment = {
  JWT_SECRET: process.env.JWT_SECRET,
  IS_ELECTRON: process.env.IS_ELECTRON,
  USER_DATA_PATH: process.env.USER_DATA_PATH,
}): string {
  const configured = environment.JWT_SECRET;
  if (configured) {
    if (configured.trim().length < 32 ||
      configured === 'your-super-secret-jwt-key-change-this-in-production') {
      throw new Error('JWT_SECRET must be a unique secret of at least 32 characters');
    }
    return configured;
  }
  if (environment.IS_ELECTRON !== 'true') {
    // Standalone operators can configure a secret to retain sessions on restart.
    return crypto.randomBytes(32).toString('hex');
  }
  if (!environment.USER_DATA_PATH) throw new Error('Electron user data path required');

  // A per-install key preserves offline desktop sessions across process restarts.
  // It is separate from logs and relies on the same OS-user boundary as app state.
  const file = path.join(environment.USER_DATA_PATH, '.session-signing-key');
  fs.mkdirSync(environment.USER_DATA_PATH, { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const secret = fs.readFileSync(file, 'utf8');
  if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('Invalid persisted session signing key');
  return secret;
}
