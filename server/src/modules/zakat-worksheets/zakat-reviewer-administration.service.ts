import { Pool, PoolClient } from 'pg';
import { AuditLogRepository } from '../audit-log/audit-log.repository';
import { MembershipRepository } from '../memberships/membership.repository';
import { ZakatForbiddenError, ZakatNotFoundError, ZakatValidationError } from './zakat-worksheet.service';

type Appointment = {
  appointment_id: string; company_id: string; user_id: string; reviewer_name: string; reviewer_email: string;
  appointment_reference: string; appointed_by_user_id: string | null; identity_verified_at: string | null;
  revoked_by_user_id: string | null; revoked_at: string | null; revocation_reason: string | null;
};

/** Company scoped administration for unique, append-only reviewer appointment identities. */
export class ZakatReviewerAdministrationService {
  private readonly audit = new AuditLogRepository();
  private readonly memberships: MembershipRepository;
  constructor(private readonly db: Pool) { this.memberships = new MembershipRepository(db); }

  private async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  private async assertAdministrator(company: string, actor: string, client: Pool | PoolClient) {
    // Lock the authorization inputs while writes proceed, then delegate the decision to
    // the same effective-capability resolver used by authenticated routes. This honors
    // policy-role restrictions, Full Access exclusions, revoked grants, and inactive members.
    const principal = await client.query(
      `SELECT 1 FROM users u JOIN companies c ON c.id=$2 AND c.is_active
       WHERE u.id=$1 AND u.is_active FOR SHARE OF u,c`, [actor, company]);
    if (!principal.rowCount) throw new ZakatForbiddenError();
    const runner = 'release' in client ? client : undefined;
    if (runner) {
      await runner.query(
        `SELECT m.id FROM memberships m JOIN roles r ON r.id=m.role_id AND r.company_id=m.company_id
         WHERE m.user_id=$1 AND m.company_id=$2 AND m.is_active FOR SHARE OF m,r`, [actor, company]);
      await runner.query(
        `SELECT rc.role_id FROM role_capabilities rc JOIN roles r ON r.id=rc.role_id
         JOIN memberships m ON m.role_id=r.id AND m.company_id=r.company_id AND m.is_active
         WHERE m.user_id=$1 AND m.company_id=$2 AND rc.capability_id='zakat.reviewer.manage'
         FOR SHARE OF rc`, [actor, company]);
    }
    const capabilities = await this.memberships.getActiveCapabilities(actor, company, runner);
    if (!capabilities.includes('zakat.reviewer.manage')) throw new ZakatForbiddenError();
  }

  async list(company: string, actor: string) {
    await this.assertAdministrator(company, actor, this.db);
    return this.listForAuthorizedActor(company);
  }

  private async listForAuthorizedActor(company: string) {
    const [appointments, candidates] = await Promise.all([
      this.db.query<Appointment>(
        `SELECT a.appointment_id,a.company_id,a.user_id,COALESCE(u.display_name,u.email) reviewer_name,
                u.email reviewer_email,a.appointment_reference,a.appointed_by_user_id,a.identity_verified_at::text,
                a.revoked_by_user_id,a.revoked_at::text,a.revocation_reason
         FROM zakat_regulatory_reviewers a JOIN users u ON u.id=a.user_id
         WHERE a.company_id=$1 ORDER BY a.identity_verified_at DESC NULLS LAST,a.appointment_id`, [company]),
      this.db.query<{ user_id: string; name: string; email: string }>(
        `SELECT u.id user_id,COALESCE(u.display_name,u.email) name,u.email
         FROM memberships m JOIN users u ON u.id=m.user_id
         WHERE m.company_id=$1 AND m.is_active AND u.is_active AND NOT u.is_system_admin
           AND NOT EXISTS (SELECT 1 FROM zakat_regulatory_reviewers a WHERE a.company_id=m.company_id AND a.user_id=m.user_id AND a.revoked_at IS NULL)
         ORDER BY COALESCE(u.display_name,u.email),u.id`, [company]),
    ]);
    return { appointments: appointments.rows, candidates: candidates.rows };
  }

  async appoint(company: string, actor: string, user: string, reference: string) {
    return this.tx(async (client) => {
      await this.assertAdministrator(company, actor, client);
      if (actor === user) throw new ZakatForbiddenError();
      const target = (await client.query<{ email: string; name: string }>(
        `SELECT COALESCE(u.display_name,u.email) name,u.email FROM users u
         JOIN memberships m ON m.user_id=u.id AND m.company_id=$2 AND m.is_active
         WHERE u.id=$1 AND u.is_active AND NOT u.is_system_admin FOR SHARE OF u,m`, [user, company])).rows[0];
      if (!target) throw new ZakatValidationError('Reviewer must be an active member of this company', 'ZAKAT_REVIEWER_NOT_ELIGIBLE');
      const appointment = (await client.query<Appointment>(
        `INSERT INTO zakat_regulatory_reviewers(company_id,user_id,appointment_reference,appointed_by_user_id,identity_verified_at)
         VALUES($1,$2,$3,$4,now())
         RETURNING appointment_id,company_id,user_id,$5::text reviewer_name,$6::text reviewer_email,
                   appointment_reference,appointed_by_user_id,identity_verified_at::text,revoked_by_user_id,revoked_at::text,revocation_reason`,
        [company, user, reference, actor, target.name, target.email])).rows[0]!;
      await this.audit.logEvent({
        company_id: company, actor_user_id: actor, action: 'zakat.reviewer.appoint', entity_type: 'zakat_reviewer_appointment', entity_id: appointment.appointment_id,
        before_data: null, after_data: { appointment_id: appointment.appointment_id, user_id: user, appointment_reference: reference, identity_verified_at: appointment.identity_verified_at },
      }, client);
      return appointment;
    });
  }

  async revoke(company: string, actor: string, appointmentId: string, reason: string) {
    return this.tx(async (client) => {
      await this.assertAdministrator(company, actor, client);
      const before = (await client.query<Appointment>(
        `SELECT a.appointment_id,a.company_id,a.user_id,COALESCE(u.display_name,u.email) reviewer_name,u.email reviewer_email,
                a.appointment_reference,a.appointed_by_user_id,a.identity_verified_at::text,a.revoked_by_user_id,
                a.revoked_at::text,a.revocation_reason
         FROM zakat_regulatory_reviewers a JOIN users u ON u.id=a.user_id
         WHERE a.company_id=$1 AND a.appointment_id=$2 FOR UPDATE OF a`, [company, appointmentId])).rows[0];
      if (!before || before.revoked_at) throw new ZakatNotFoundError();
      const after = (await client.query<Appointment>(
        `UPDATE zakat_regulatory_reviewers SET revoked_by_user_id=$3,revoked_at=now(),revocation_reason=$4
         WHERE company_id=$1 AND appointment_id=$2
         RETURNING appointment_id,company_id,user_id,$5::text reviewer_name,$6::text reviewer_email,
                   appointment_reference,appointed_by_user_id,identity_verified_at::text,revoked_by_user_id,revoked_at::text,revocation_reason`,
        [company, appointmentId, actor, reason, before.reviewer_name, before.reviewer_email])).rows[0]!;
      await this.audit.logEvent({
        company_id: company, actor_user_id: actor, action: 'zakat.reviewer.revoke', entity_type: 'zakat_reviewer_appointment', entity_id: appointmentId,
        before_data: { user_id: before.user_id, appointment_reference: before.appointment_reference, revoked_at: null },
        after_data: { user_id: after.user_id, appointment_reference: after.appointment_reference, revoked_at: after.revoked_at, revocation_reason: reason }, reason,
      }, client);
      return after;
    });
  }
}
