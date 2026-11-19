import { Pool } from 'pg';

// Operator entry point only. There is no startup hook, migration or HTTP route.
export async function transitionPolicy(pool: Pool, args: string[]): Promise<void> {
  const [database, actor, kind, target, scope, from, to, approval] = args;
  if (args.length !== 8 || !database || !actor || !target || !scope ||
      !((kind === 'admin' && scope === 'global') || (kind === 'role' && scope !== 'global')) ||
      !((from === '0' && to === '1') || (from === '1' && to === '0')) || !approval?.trim()) {
    throw new Error('Expected DATABASE ACTOR_ID admin|role TARGET_ID global|COMPANY_ID FROM TO APPROVAL_REFERENCE');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const identity = (await client.query('SELECT current_database() AS database, session_user AS operator')).rows[0];
    if (identity.database !== database) throw new Error('Unexpected database');
    // Validate the named application actor under lock, independently of company grants.
    const admin = await client.query('SELECT id FROM users WHERE id=$1 AND is_active AND is_system_admin FOR SHARE', [actor]);
    if (!admin.rowCount) throw new Error('Active System Administrator required');
    const action = to === '1' ? 'authorization.policy.activate' : 'authorization.policy.rollback';
    const before = { version: Number(from) };
    const after = { version: Number(to), approval, operator: identity.operator };
    if (kind === 'admin') {
      const update = await client.query(
        'UPDATE users SET system_admin_policy_version=$3 WHERE id=$1 AND is_active AND is_system_admin AND system_admin_policy_version=$2',
        [target, from, to]);
      if (update.rowCount !== 1) throw new Error('Administrator or expected version mismatch');
      await client.query(
        'INSERT INTO system_audit_log(actor_user_id,actor_label,target_user_id,action,before_data,after_data) VALUES($1,$2,$3,$4,$5,$6)',
        [actor, identity.operator, target, action, before, after]);
    } else {
      const update = await client.query(
        `UPDATE roles SET authorization_policy_version=$4 WHERE id=$1 AND company_id=$2 AND authorization_policy_version=$3
         AND NOT is_full_access AND authorization_policy_key IN ('company_manager','finance_manager')`, [target, scope, from, to]);
      if (update.rowCount !== 1) throw new Error('Company, role or expected version mismatch');
      await client.query(
        `INSERT INTO audit_log(company_id,actor_user_id,entity_type,entity_id,action,before_data,after_data,reason)
         VALUES($1,$2,'role',$3,$4,$5,$6,$7)`, [scope, actor, target, action, before, after, approval]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  const connectionString = process.env.AUTHORIZATION_OPERATOR_DATABASE_URL;
  if (!connectionString) throw new Error('Named operator database connection required');
  const pool = new Pool({ connectionString });
  transitionPolicy(pool, process.argv.slice(2))
    .catch((error: Error) => { console.error(error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
