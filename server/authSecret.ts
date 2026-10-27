import crypto from 'crypto';

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
  throw new Error('Electron must provide an OS-protected session signing key');
}
