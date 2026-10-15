import crypto from 'crypto';
import { Pool } from 'pg';
import { AuthService } from '../users/auth.service';
import { MembershipRepository, ActiveCompanyMembership } from '../memberships/membership.repository';
import { SessionRepository } from './session.repository';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface AllowedCompany {
  id: string;
  name: string;
  name_ar: string | null;
}

export interface AuthSessionContext {
  user: {
    id: string;
    email: string;
    /** Global System Admin (users.is_system_admin). Display/UX hint only; every check is re-derived server-side. */
    isSystemAdmin: boolean;
  };
  allowedCompanies: AllowedCompany[];
  activeCompanyId: string | null;
  capabilities: string[];
}

export interface LoginResult extends AuthSessionContext {
  token: string;
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function toAllowedCompanies(rows: ActiveCompanyMembership[]): AllowedCompany[] {
  return rows.map((row) => ({
    id: row.company_id,
    name: row.company_name,
    name_ar: row.company_name_ar,
  }));
}

export class SessionService {
  private readonly auth: AuthService;
  private readonly memberships: MembershipRepository;
  private readonly sessions: SessionRepository;

  constructor(private readonly pool: Pool) {
    this.auth = new AuthService(pool);
    this.memberships = new MembershipRepository(pool);
    this.sessions = new SessionRepository(pool);
  }

  /**
   * Companies the user may select: every active company for an active System Admin (global authority), otherwise only
   * companies with an active membership. The System Admin flag comes from the same users row that authenticated the
   * request (session join or login lookup), never from client input.
   */
  private selectableCompanies(userId: string, isSystemAdmin: boolean): Promise<ActiveCompanyMembership[]> {
    return isSystemAdmin
      ? this.memberships.listAllActiveCompaniesForSystemAdmin(userId)
      : this.memberships.listActiveCompaniesForUser(userId);
  }

  async login(email: string, password: string): Promise<LoginResult | null> {
    const user = await this.auth.authenticate(email, password);
    if (!user) return null;

    const isSystemAdmin = user.is_system_admin === true;
    const memberships = await this.selectableCompanies(user.id, isSystemAdmin);
    const activeCompanyId = memberships[0]?.company_id ?? null;
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

    await this.sessions.create({
      userId: user.id,
      tokenHash,
      activeCompanyId,
      expiresAt,
    });

    const capabilities = activeCompanyId
      ? await this.memberships.getActiveCapabilities(user.id, activeCompanyId)
      : [];

    return {
      token,
      user: { id: user.id, email: user.email, isSystemAdmin },
      allowedCompanies: toAllowedCompanies(memberships),
      activeCompanyId,
      capabilities,
    };
  }

  async getContext(token: string): Promise<AuthSessionContext | null> {
    const session = await this.sessions.findActiveByTokenHash(hashToken(token));
    if (!session) return null;

    const memberships = await this.selectableCompanies(session.user_id, session.user_is_system_admin === true);
    const allowedIds = new Set(memberships.map((m) => m.company_id));
    const reconciledCompanyId =
      session.active_company_id && allowedIds.has(session.active_company_id)
        ? session.active_company_id
        : memberships[0]?.company_id ?? null;

    if (reconciledCompanyId !== session.active_company_id) {
      await this.sessions.updateActiveCompany(session.id, reconciledCompanyId);
    }

    const capabilities = reconciledCompanyId
      ? await this.memberships.getActiveCapabilities(session.user_id, reconciledCompanyId)
      : [];

    return {
      user: { id: session.user_id, email: session.user_email, isSystemAdmin: session.user_is_system_admin === true },
      allowedCompanies: toAllowedCompanies(memberships),
      activeCompanyId: reconciledCompanyId,
      capabilities,
    };
  }

  async switchCompany(token: string, requestedCompanyId: string): Promise<AuthSessionContext | 'forbidden' | null> {
    const session = await this.sessions.findActiveByTokenHash(hashToken(token));
    if (!session) return null;

    const memberships = await this.selectableCompanies(session.user_id, session.user_is_system_admin === true);
    const target = memberships.find((m) => m.company_id === requestedCompanyId);
    if (!target) return 'forbidden';

    await this.sessions.updateActiveCompany(session.id, requestedCompanyId);
    const capabilities = await this.memberships.getActiveCapabilities(
      session.user_id,
      requestedCompanyId,
    );

    return {
      user: { id: session.user_id, email: session.user_email, isSystemAdmin: session.user_is_system_admin === true },
      allowedCompanies: toAllowedCompanies(memberships),
      activeCompanyId: requestedCompanyId,
      capabilities,
    };
  }

  async logout(token: string): Promise<void> {
    await this.sessions.deleteByTokenHash(hashToken(token));
  }
}
