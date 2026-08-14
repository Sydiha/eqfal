import pool from '../../db/pool';
import logger from '../../shared/logger';

export interface HealthReport {
  status: 'ok';
  timestamp: string;
  version: string;
  services: {
    database: {
      status: 'connected' | 'disconnected';
      latency_ms: number | null;
    };
  };
}

export async function checkHealth(): Promise<HealthReport> {
  let dbStatus: 'connected' | 'disconnected' = 'disconnected';
  let dbLatencyMs: number | null = null;

  if (pool) {
    try {
      const start = Date.now();
      await pool.query('SELECT 1');
      dbLatencyMs = Date.now() - start;
      dbStatus = 'connected';
    } catch (err) {
      logger.warn({ err }, 'Health check: DB query failed');
    }
  }

  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: process.env['npm_package_version'] ?? '0.0.1',
    services: {
      database: { status: dbStatus, latency_ms: dbLatencyMs },
    },
  };
}
