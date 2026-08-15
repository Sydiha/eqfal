import dotenv from 'dotenv';
import path from 'path';

// Load .env from project root (local dev); Replit injects vars directly
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const config = {
  env: process.env['NODE_ENV'] ?? 'development',
  port: Number(process.env['PORT'] ?? 3001),
  databaseUrl: process.env['DATABASE_URL'] ?? '',
  sessionSecret: process.env['SESSION_SECRET'] ?? '',
  logLevel: process.env['LOG_LEVEL'] ?? 'info',
  documentStorageDir: process.env['DOCUMENT_STORAGE_DIR'] ?? path.resolve(process.cwd(), '.data/documents'),
} as const;

export default config;
