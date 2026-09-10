import { Pool } from 'pg';

type QueryRunner = Pick<Pool, 'query'>;

export type VatReconciliationStatus =
  | 'reconciled'
  | 'missing_posted_journal'
  | 'missing_vat_line'
  | 'wrong_vat_direction'
  | 'vat_amount_mismatch';

export interface VatReconciliationDocument {
  document_id: string;
  obligation_id: string;
  document_type: 'purchase' | 'expense' | 'sale';
  tax_date: string;
  treatment: 'standard' | 'zero_rated' | 'exempt' | 'out_of_scope';
  reviewed_vat_amount: string;
  expected_memo: 'VAT_INPUT' | 'VAT_OUTPUT';
  journal_entry_id: string | null;
  journal_status: 'draft' | 'posted' | null;
  ledger_vat_amount: string | null;
  reconciliation_status: VatReconciliationStatus;
}

export interface VatReconciliation {
  totals: {
    reviewed_output_vat: number;
    reviewed_input_vat: number;
    ledger_output_vat: number;
    ledger_input_vat: number;
    output_difference: number;
    input_difference: number;
  };
  counts: { total_in_scope: number; reconciled: number; unreconciled: number };
  documents: VatReconciliationDocument[];
}

/** Loads only the document -> confirmed obligation -> obligation journal path. */
export async function loadVatReconciliation(
  db: QueryRunner,
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<VatReconciliation> {
  const { rows } = await db.query<VatReconciliationDocument>(`WITH scoped AS (
    SELECT d.id document_id,o.id obligation_id,d.document_type,r.tax_date,r.treatment,
      r.vat_amount reviewed_vat_amount,
      CASE WHEN d.document_type='sale' THEN 'VAT_OUTPUT' ELSE 'VAT_INPUT' END expected_memo
    FROM documents d
    JOIN document_vat_reviews r ON r.document_id=d.id AND r.company_id=d.company_id
    JOIN obligations o ON o.document_id=d.id AND o.company_id=d.company_id
      AND o.source_type='document' AND NOT o.is_cancelled AND o.verification_status='confirmed'
    WHERE d.company_id=$1 AND d.status='approved'
      AND d.document_type IN ('purchase','expense','sale')
      AND r.review_status='reviewed' AND r.tax_date BETWEEN $2 AND $3
  ), evaluated AS (
    SELECT s.*,j.id journal_entry_id,j.status journal_status,
      expected_lines.line_count expected_line_count,
      CASE WHEN expected_lines.line_count=1 THEN expected_lines.amount::text END ledger_vat_amount,
      COALESCE(expected_lines.direction_ok,FALSE) direction_ok,
      COALESCE(opposite_lines.line_count,0) opposite_line_count
    FROM scoped s
    LEFT JOIN journal_entries j ON j.company_id=$1 AND j.source_type='obligation' AND j.source_id=s.obligation_id
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int line_count,
        CASE WHEN COUNT(*)=1 THEN MAX(CASE WHEN s.expected_memo='VAT_OUTPUT' THEN l.credit ELSE l.debit END) END amount,
        CASE WHEN COUNT(*)=1 THEN BOOL_AND(
          CASE WHEN s.expected_memo='VAT_OUTPUT' THEN l.credit>0 AND l.debit=0 ELSE l.debit>0 AND l.credit=0 END
        ) ELSE FALSE END direction_ok
      FROM journal_lines l
      WHERE l.company_id=$1 AND l.journal_entry_id=j.id AND l.memo=s.expected_memo
    ) expected_lines ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int line_count FROM journal_lines l
      WHERE l.company_id=$1 AND l.journal_entry_id=j.id
        AND l.memo=CASE WHEN s.expected_memo='VAT_OUTPUT' THEN 'VAT_INPUT' ELSE 'VAT_OUTPUT' END
    ) opposite_lines ON TRUE
  )
  SELECT document_id,obligation_id,document_type,tax_date::text,treatment,
    reviewed_vat_amount::text,expected_memo,journal_entry_id,journal_status,ledger_vat_amount,
    CASE
      WHEN reviewed_vat_amount=0 THEN 'reconciled'
      WHEN journal_entry_id IS NULL OR journal_status<>'posted' THEN 'missing_posted_journal'
      WHEN expected_line_count=0 AND opposite_line_count>0 THEN 'wrong_vat_direction'
      WHEN expected_line_count=0 THEN 'missing_vat_line'
      WHEN expected_line_count>1 THEN 'vat_amount_mismatch'
      WHEN NOT direction_ok THEN 'wrong_vat_direction'
      WHEN ledger_vat_amount::numeric<>reviewed_vat_amount THEN 'vat_amount_mismatch'
      ELSE 'reconciled'
    END reconciliation_status
  FROM evaluated ORDER BY tax_date,document_id`, [companyId, periodStart, periodEnd]);

  let reviewedOutput = 0, reviewedInput = 0, ledgerOutput = 0, ledgerInput = 0, reconciled = 0;
  for (const document of rows) {
    const reviewed = Number(document.reviewed_vat_amount);
    if (document.document_type === 'sale') reviewedOutput += reviewed;
    else reviewedInput += reviewed;
    if (document.reconciliation_status === 'reconciled') {
      reconciled += 1;
      const ledger = Number(document.ledger_vat_amount ?? 0);
      if (document.document_type === 'sale') ledgerOutput += ledger;
      else ledgerInput += ledger;
    }
  }
  return {
    totals: {
      reviewed_output_vat: reviewedOutput,
      reviewed_input_vat: reviewedInput,
      ledger_output_vat: ledgerOutput,
      ledger_input_vat: ledgerInput,
      output_difference: reviewedOutput - ledgerOutput,
      input_difference: reviewedInput - ledgerInput,
    },
    counts: { total_in_scope: rows.length, reconciled, unreconciled: rows.length - reconciled },
    documents: rows,
  };
}
