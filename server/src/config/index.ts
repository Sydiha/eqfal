import dotenv from 'dotenv';
import path from 'path';
import { parseTrustProxy } from '../modules/auth/login-rate-limit';

// Load .env from project root (local dev); Replit injects vars directly
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const config = {
  env: process.env['NODE_ENV'] ?? 'development',
  port: Number(process.env['PORT'] ?? 3001),
  databaseUrl: process.env['DATABASE_URL'] ?? '',
  sessionSecret: process.env['SESSION_SECRET'] ?? '',
  // Express 'trust proxy' (see parseTrustProxy). Default: trust nothing, so X-Forwarded-For is ignored.
  trustProxy: parseTrustProxy(process.env['TRUST_PROXY']),
  logLevel: process.env['LOG_LEVEL'] ?? 'info',
  documentStorageDir: process.env['DOCUMENT_STORAGE_DIR'] ?? path.resolve(process.cwd(), '.data/documents'),
  bankStorageDir: process.env['BANK_STORAGE_DIR'] ?? path.resolve(process.cwd(), '.data/bank-imports'),
} as const;

export default config;
