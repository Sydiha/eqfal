import { Pool, PoolClient } from 'pg';
import { CreateDocumentInput, DocumentRecord } from './document.types';

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
}
