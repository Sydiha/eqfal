export type DocumentStatus = 'uploaded' | 'needs_review' | 'approved' | 'incomplete' | 'rejected';
export type DocumentType = 'purchase' | 'expense' | 'sale' | 'other';

export interface DocumentIntake {
  document_type: DocumentType | null;
  counterparty_name: string | null;
  document_date: string | null;
  reference_number: string | null;
  total_amount: string | null;
  intake_note: string | null;
}

export interface DocumentRecord extends DocumentIntake {
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

export type DocumentIntakeUpdate = Partial<{
  [K in keyof DocumentIntake]: K extends 'total_amount' ? number | null : DocumentIntake[K]
}>;

export type DocumentReviewDecision = Extract<DocumentStatus, 'approved' | 'incomplete' | 'rejected'>;

export interface CreateDocumentInput {
  company_id: string;
  uploaded_by_user_id: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  storage_key: string;
  sha256: string;
}
