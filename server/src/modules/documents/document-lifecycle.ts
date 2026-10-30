import type { Pool, PoolClient } from 'pg';
import type { DocumentDuplicateMatch, DocumentIntakeUpdate, DocumentRecord } from './document.types';

type Runner = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

/** R6: fields whose change on a previously reviewed document needs an explicit, audited reason (the free-text note is not sensitive). */
export const SENSITIVE_INTAKE_FIELDS = ['document_type', 'counterparty_id', 'counterparty_name', 'document_date', 'reference_number', 'total_amount'] as const;
export const MAX_CHANGE_REASON = 500;
/** Statuses whose file may be replaced. needs_review is excluded so a reviewer never sees the file change under them; approved and rejected are final. */
export const FILE_REPLACEABLE_STATUSES: readonly DocumentRecord['status'][] = ['uploaded', 'incomplete'];

/** A document that was reviewed before (then reopened) is being changed without a reason. Nothing is written. */
export class DocumentChangeReasonRequiredError extends Error {
  readonly code = 'DOCUMENT_CHANGE_REASON_REQUIRED';
  constructor() { super('A reason is required to change a previously reviewed document'); }
}
/** The replacement is refused: wrong status, or the new file is identical to the current one. */
export class DocumentFileReplaceError extends Error {
  constructor(readonly code: 'DOCUMENT_FILE_REPLACE_NOT_ALLOWED' | 'DOCUMENT_FILE_UNCHANGED') { super('Document file cannot be replaced'); }
}

export function wasReviewed(document: Pick<DocumentRecord, 'reviewed_at'>): boolean {
  return document.reviewed_at !== null && document.reviewed_at !== undefined;
}

export function normalizeReference(value: string | null | undefined): string | null {
  const normalized = (value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  return normalized || null;
}

export interface DuplicateProbe {
  documentId: string;
  sha256: string;
  counterparty_id: string | null;
  counterparty_name: string | null;
  reference_number: string | null;
}

/**
 * Advisory duplicate lookup, always inside one company. Two independent signals:
 *  - same file fingerprint (sha256), any status;
 *  - same counterparty (id, or normalized name when the document has no id) AND same normalized reference number, excluding rejected documents.
 * A match is a warning for a human to confirm, never a block: the same supplier can legitimately reuse a number (new year, credit note).
 */
export async function findDuplicateMatches(runner: Runner, companyId: string, probe: DuplicateProbe): Promise<DocumentDuplicateMatch[]> {
  const reference = normalizeReference(probe.reference_number);
  const name = normalizeReference(probe.counterparty_name);
  const { rows } = await runner.query<DocumentDuplicateMatch>(
    `SELECT id, original_filename, status, created_at, document_date::text, reference_number, total_amount,
            CASE WHEN sha256 = $3 THEN 'file' ELSE 'supplier_reference' END AS match
       FROM documents
      WHERE company_id = $1 AND id <> $2
        AND (sha256 = $3
             OR ($4::text IS NOT NULL AND status <> 'rejected'
                 AND lower(regexp_replace(btrim(reference_number), '\\s+', ' ', 'g')) = $4
                 AND (($5::uuid IS NOT NULL AND counterparty_id = $5)
                      OR ($5::uuid IS NULL AND $6::text IS NOT NULL AND counterparty_id IS NULL
                          AND lower(regexp_replace(btrim(counterparty_name), '\\s+', ' ', 'g')) = $6))))
      ORDER BY created_at DESC LIMIT 10`,
    [companyId, probe.documentId, probe.sha256, reference, probe.counterparty_id, name],
  );
  return rows;
}

export function sensitiveChanges(changed: readonly string[]): string[] {
  return changed.filter((field) => (SENSITIVE_INTAKE_FIELDS as readonly string[]).includes(field));
}
export type { DocumentIntakeUpdate };
