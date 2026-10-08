# Initial Company & Administrator Bootstrap (Private Beta)

One-time, manually run CLI that creates the first company and its Full Access administrator on a **fresh, empty** database. There is no public API and no anonymous registration.

## Safety properties
- Refuses (exit code 2, nothing written) if **any** user or company already exists. No recovery/overwrite mode exists.
- Single transaction: user, company, 4 default roles, Full Access membership, `company.create` and `bootstrap.initialize` audit entries commit together or not at all.
- Concurrent runs are serialised (advisory lock + table lock); exactly one can succeed.
- Reuses `CompanyManagementService` (same roles/permissions/audit as normal company creation). Never modifies or deletes existing rows. No schema change.
- The password is never accepted as an argument or env var, never logged, never stored in audit data (only a bcrypt hash is stored). Minimum 12 characters, maximum 72 bytes.

## Usage
Migrations must already be applied. `DATABASE_URL` selects the target; the CLI prints host/port/database (no credentials) before acting.

```
cd server
DATABASE_URL=... npm run bootstrap:admin -- \
  --email owner@your-domain \
  --company-slug my-company --company-name "My Company" [--company-name-ar "..."] \
  --confirm-slug my-company
```
Production / compiled output (no `tsx` or dev dependencies needed; run `npm run build -w server` first):
```
cd server
DATABASE_URL=... node dist/cli/bootstrap-admin.js --email ... --company-slug ... --company-name ... --confirm-slug ...
```
(`npm run bootstrap:admin:compiled -- <args>` is the same command.)

`--confirm-slug` must equal `--company-slug` (explicit operator confirmation). The password is prompted twice (hidden) in a terminal; if stdin is piped, the first line is used (e.g. from a secrets manager, never `echo` in shell history).

## Tests
`server/test/bootstrap-admin.postgres.test.ts` creates and drops its own disposable database from `DATABASE_URL`, using synthetic data only.
