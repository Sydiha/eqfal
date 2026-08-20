export type DocumentStatus = 'uploaded' | 'needs_review' | 'approved' | 'incomplete' | 'rejected';
export type DocumentType = 'purchase' | 'expense' | 'sale' | 'other';

export interface DocumentIntake {
  document_type: DocumentType | null;
  counterparty_id: string | null;
  counterparty_name: string | null;
  document_date: string | null;
  reference_number: string | null;
  total_amount: string | null;
  intake_note: string | null;
}

export interface DocumentRecord extends DocumentIntake {
  relational_counterparty_name?: string | null;
  id: string;
  company_id: string;
  uploaded_by_user_id: string;
  status: DocumentStatus;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  storage_key: string;
  sha256: string;
  reviewed_by_user_id: string | null;
  reviewed_at: Date | null;
  review_note: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface DocumentCounterparty {
  id: string;
  name: string;
  is_active: boolean;
}

export type DocumentIntakeUpdate = Partial<{
  [K in keyof DocumentIntake]: K extends 'total_amount' ? number | null : DocumentIntake[K]
}>;

export type DocumentReviewDecision = Extract<DocumentStatus, 'approved' | 'incomplete' | 'rejected'>;

export function isValidDocumentDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function isValidDocumentTotalAmount(value: unknown): boolean {
  const amount = typeof value === 'number' ? String(value) : value;
  return typeof amount === 'string'
    && /^(0|[1-9]\d*)(\.\d{1,2})?$/.test(amount)
    && Number.isFinite(Number(amount))
    && Number(amount) > 0
    && Number(amount) < 1e16;
}

export interface CreateDocumentInput {
  company_id: string;
  uploaded_by_user_id: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  storage_key: string;
  sha256: string;
}

