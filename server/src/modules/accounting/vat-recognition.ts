import type { PoolClient } from 'pg';

type QueryRunner = Pick<PoolClient, 'query'>;
type VatMemo = 'VAT_INPUT' | 'VAT_OUTPUT';
type VatRequirement = {
  documentId: string;
  memo: VatMemo;
  accountType: 'asset' | 'liability';
  debit: string;
  credit: string;
};

export const VAT_RECOGNITION_ERROR_CODE = 'VAT_RECOGNITION_INCOMPLETE';

export class VatRecognitionIncompleteError extends Error {
  constructor() {
    super('Reviewed VAT is not correctly recognized in the journal');
  }
}

async function requirementForSource(
  companyId: string,
  sourceType: string,
  sourceId: string,
  client: QueryRunner,
): Promise<VatRequirement | null> {
  // Obligation recognition has a one-to-one gross document amount, so its VAT
  // amount can be derived safely. Split custody allocations can span one
  // document, so assigning the full document VAT to one allocation would be unsafe.
  if (sourceType !== 'obligation') return null;

  const { rows } = await client.query<{
    document_id: string;
    document_type: 'sale' | 'purchase' | 'expense';
    review_status: 'pending' | 'reviewed' | null;
    vat_amount: string | null;
  }>(
    `SELECT d.id document_id,d.document_type,r.review_status,r.vat_amount::numeric(18,2)::text vat_amount
     FROM obligations o
     JOIN documents d ON d.id=o.document_id AND d.company_id=o.company_id
       AND d.status='approved' AND d.document_type IN ('sale','purchase','expense')
     LEFT JOIN document_vat_reviews r ON r.document_id=d.id AND r.company_id=d.company_id
     WHERE o.company_id=$1 AND o.id=$2 AND o.source_type='document'
     LIMIT 1`,
    [companyId, sourceId],
  );
  const row = rows[0];
  if (!row || row.review_status !== 'reviewed' || row.vat_amount === null || Number(row.vat_amount) <= 0) return null;

  if (row.document_type === 'sale') {
    return {
      documentId: row.document_id,
      memo: 'VAT_OUTPUT',
      accountType: 'liability',
      debit: '0.00',
      credit: row.vat_amount,
    };
  }
  return {
    documentId: row.document_id,
    memo: 'VAT_INPUT',
    accountType: 'asset',
    debit: row.vat_amount,
    credit: '0.00',
  };
}

export async function enforceVatRecognition(
  companyId: string,
  journalId: string,
  sourceType: string,
  sourceId: string,
  client: QueryRunner,
) {
  const requirement = await requirementForSource(companyId, sourceType, sourceId, client);
  if (!requirement) return null;

  const { rows: candidates } = await client.query<{ id: string }>(
    `SELECT l.id
     FROM journal_lines l
     JOIN accounts a ON a.id=l.account_id AND a.company_id=l.company_id
     WHERE l.company_id=$1 AND l.journal_entry_id=$2 AND a.account_type=$3
       AND l.debit=$4::numeric(18,2) AND l.credit=$5::numeric(18,2)`,
    [companyId, journalId, requirement.accountType, requirement.debit, requirement.credit],
  );
  if (candidates.length !== 1) throw new VatRecognitionIncompleteError();

  const candidateId = candidates[0]!.id;
  const reservedElsewhere = await client.query(
    `SELECT 1 FROM journal_lines
     WHERE company_id=$1 AND journal_entry_id=$2 AND id<>$3 AND memo IN ('VAT_INPUT','VAT_OUTPUT')
     LIMIT 1`,
    [companyId, journalId, candidateId],
  );
  if (reservedElsewhere.rowCount) throw new VatRecognitionIncompleteError();

  await client.query(
    'UPDATE journal_lines SET memo=$3 WHERE id=$1 AND company_id=$2',
    [candidateId, companyId, requirement.memo],
  );
  return requirement;
}
