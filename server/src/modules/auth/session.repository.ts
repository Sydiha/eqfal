import { Pool } from 'pg';

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  active_company_id: string | null;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface ActiveSessionRow extends SessionRow {
  user_email: string;
}

export class SessionRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: {
    userId: string;
    tokenHash: string;
    activeCompanyId: string | null;
    expiresAt: Date;
  }): Promise<SessionRow> {
    const { rows } = await this.pool.query<SessionRow>(
      `INSERT INTO sessions (user_id, token_hash, active_company_id, expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [input.userId, input.tokenHash, input.activeCompanyId, input.expiresAt],
    );
    return rows[0] as SessionRow;
  }

  async findActiveByTokenHash(tokenHash: string): Promise<ActiveSessionRow | null> {
    const { rows } = await this.pool.query<ActiveSessionRow>(
      `SELECT s.*, u.email AS user_email
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1
         AND s.expires_at > NOW()
         AND u.is_active = TRUE`,
      [tokenHash],
    );
    return rows[0] ?? null;
  }

  async updateActiveCompany(sessionId: string, companyId: string | null): Promise<void> {
    await this.pool.query(
      `UPDATE sessions
       SET active_company_id = $1, updated_at = NOW()
       WHERE id = $2`,
      [companyId, sessionId],
    );
  }

  async deleteByTokenHash(tokenHash: string): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
  }
}
