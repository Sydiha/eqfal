import { createInterface } from 'node:readline';
import { Pool } from 'pg';
import { BootstrapError, bootstrapInitialAdmin, BootstrapInput } from '../modules/bootstrap/bootstrap.service';

const USAGE = `Usage: bootstrap-admin --email <email> --company-slug <slug> --company-name <name> [--company-name-ar <name>] --confirm-slug <slug>
Password is read from the terminal (hidden, asked twice) or, when stdin is not a terminal, from the first line of stdin.
It is never accepted as an argument or environment variable. DATABASE_URL selects the target database.`;

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const allowed = new Set(['email', 'company-slug', 'company-name', 'company-name-ar', 'confirm-slug']);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '') ?? '';
    const value = argv[i + 1];
    if (!argv[i]?.startsWith('--') || !allowed.has(key) || value === undefined) throw new BootstrapError('INVALID_INPUT', `Unknown or incomplete argument: ${argv[i]}`);
    out[key] = value;
  }
  return out;
}

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(prompt);
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    let value = '';
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); process.stderr.write('\n'); return resolve(value); }
        if (ch === '\u0003') { stdin.setRawMode(false); return reject(new Error('Cancelled.')); }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1); else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function readPassword(): Promise<string> {
  if (process.stdin.isTTY) {
    const first = await readHidden('Administrator password: ');
    const second = await readHidden('Repeat password: ');
    if (first !== second) throw new BootstrapError('INVALID_INPUT', 'Passwords do not match.');
    return first;
  }
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) { rl.close(); return line; }
  throw new BootstrapError('INVALID_INPUT', 'No password provided on stdin.');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { email, 'company-slug': slug, 'company-name': name, 'confirm-slug': confirm } = args;
  if (!email || !slug || !name) throw new BootstrapError('INVALID_INPUT', USAGE);
  if (confirm !== slug) throw new BootstrapError('INVALID_INPUT', 'Explicit confirmation required: pass --confirm-slug equal to --company-slug.');
  const url = process.env['DATABASE_URL'];
  if (!url) throw new BootstrapError('INVALID_INPUT', 'DATABASE_URL is not set.');
  const target = new URL(url);
  console.error(`Target database: ${target.hostname}:${target.port || '5432'}${target.pathname}`);
  const input: BootstrapInput = { email, password: await readPassword(), company: { slug, name, name_ar: args['company-name-ar'] ?? null } };
  const pool = new Pool({ connectionString: url, max: 2 });
  try {
    const result = await bootstrapInitialAdmin(pool, input);
    console.log(`Bootstrap complete: administrator ${result.email} created with Full Access in company "${result.slug}".`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof BootstrapError ? `${error.code}: ${error.message}` : 'Bootstrap failed (no changes were committed).');
  process.exit(error instanceof BootstrapError && error.code === 'ALREADY_INITIALIZED' ? 2 : 1);
});
