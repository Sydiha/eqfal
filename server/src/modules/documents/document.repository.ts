import { Pool, PoolClient } from 'pg';
import { CreateDocumentInput, DocumentIntakeUpdate, DocumentRecord, DocumentStatus } from './document.types';

type QueryRunner = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

export class DocumentRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateDocumentInput, runner: QueryRunner): Promise<DocumentRecord> {
    const { rows } = await runner.query<DocumentRecord>(
      `INSERT INTO documents
         (company_id, uploaded_by_user_id, original_filename, mime_type,
          size_bytes, storage_key, sha256)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [
        input.company_id,
        input.uploaded_by_user_id,
        input.original_filename,
        input.mime_type,
        input.size_bytes,
        input.storage_key,
        input.sha256,
      ],
    );
    return rows[0]!;
  }

  async findByCompany(companyId: string): Promise<DocumentRecord[]> {
    const { rows } = await this.pool.query<DocumentRecord>(
      `SELECT * FROM documents
       WHERE company_id = $1
       ORDER BY created_at DESC`,
      [companyId],
    );
    return rows;
  }

  async findById(id: string, companyId: string): Promise<DocumentRecord | null> {
    const { rows } = await this.pool.query<DocumentRecord>(
      `SELECT * FROM documents
       WHERE id = $1 AND company_id = $2`,
      [id, companyId],
    );
    return rows[0] ?? null;
  }

  async findByIdForUpdate(id: string, companyId: string, runner: QueryRunner): Promise<DocumentRecord | null> {
    const { rows } = await runner.query<DocumentRecord>(
      `SELECT * FROM documents WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [id, companyId],
    );
    return rows[0] ?? null;
  }

  async updateIntake(id: string, companyId: string, intake: DocumentIntakeUpdate, runner: QueryRunner): Promise<DocumentRecord> {
    const fields = Object.keys(intake) as (keyof DocumentIntakeUpdate)[];
    const assignments = fields.map((field, index) => `${field} = $${index + 3}`);
    const { rows } = await runner.query<DocumentRecord>(
      `UPDATE documents SET ${assignments.join(', ')}, updated_at = NOW()
       WHERE id = $1 AND company_id = $2 RETURNING *`,
      [id, companyId, ...fields.map((field) => intake[field])],
    );
    return rows[0]!;
  }

  async submitForReview(id: string, companyId: string, runner: QueryRunner): Promise<DocumentRecord> {
    const { rows } = await runner.query<DocumentRecord>(
      `UPDATE documents
       SET status = 'needs_review', updated_at = NOW()
       WHERE id = $1 AND company_id = $2 RETURNING *`,
      [id, companyId],
    );
    return rows[0]!;
  }

  async updateReview(id: string, companyId: string, status: DocumentStatus, actorUserId: string, note: string | null, runner: QueryRunner): Promise<DocumentRecord> {
    const { rows } = await runner.query<DocumentRecord>(
      `UPDATE documents
       SET status = $3, reviewed_by_user_id = $4, reviewed_at = NOW(), review_note = $5, updated_at = NOW()
       WHERE id = $1 AND company_id = $2 RETURNING *`,
      [id, companyId, status, actorUserId, note],
    );
    return rows[0]!;
  }
}
