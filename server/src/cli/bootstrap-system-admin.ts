import { Pool } from 'pg';
import { SystemAdminBootstrapError, bootstrapSystemAdmin } from '../modules/memberships/system-admin.service';

const USAGE = `Usage: bootstrap-system-admin --email <existing-account-email> --confirm-email <same-email>
One-time procedure: promotes ONE existing, active account to global System Admin. It refuses when any System Admin
already exists, never creates accounts or passwords, and writes system_audit_log. DATABASE_URL selects the database.
Run it only after separate, explicit Owner approval.`;

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const allowed = new Set(['email', 'confirm-email']);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '') ?? '';
    const value = argv[i + 1];
    if (!argv[i]?.startsWith('--') || !allowed.has(key) || value === undefined) throw new SystemAdminBootstrapError('INVALID_INPUT', `Unknown or incomplete argument: ${argv[i]}\n${USAGE}`);
    out[key] = value;
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const email = args['email'];
  if (!email) throw new SystemAdminBootstrapError('INVALID_INPUT', USAGE);
  if (args['confirm-email']?.toLowerCase() !== email.toLowerCase()) throw new SystemAdminBootstrapError('INVALID_INPUT', 'Explicit confirmation required: pass --confirm-email equal to --email.');
  const url = process.env['DATABASE_URL'];
  if (!url) throw new SystemAdminBootstrapError('INVALID_INPUT', 'DATABASE_URL is not set.');
  const target = new URL(url);
  console.error(`Target database: ${target.hostname}:${target.port || '5432'}${target.pathname}`);
  const pool = new Pool({ connectionString: url, max: 2 });
  try {
    const result = await bootstrapSystemAdmin(pool, email);
    console.log(`System Admin bootstrap complete: ${result.email} is now the first System Admin.`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof SystemAdminBootstrapError ? `${error.code}: ${error.message}` : 'System Admin bootstrap failed (no changes were committed).');
  process.exit(error instanceof SystemAdminBootstrapError && error.code === 'ALREADY_INITIALIZED' ? 2 : 1);
});
