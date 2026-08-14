import { Pool } from 'pg';
import config from '../config';
import logger from '../shared/logger';

let pool: Pool | null = null;

if (config.databaseUrl) {
  pool = new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 2_000,
  });

  pool.on('error', (err) => {
    logger.error({ err }, 'Unexpected DB pool error');
  });
}

export default pool;
