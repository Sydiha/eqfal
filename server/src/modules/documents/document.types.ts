export type DocumentStatus = 'uploaded' | 'needs_review' | 'approved' | 'incomplete' | 'rejected';

export interface DocumentRecord {
  id: string;
  company_id: string;
  uploaded_by_user_id: string;
  status: DocumentStatus;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  storage_key: string;
  sha256: string;
  created_at: Date;
  updated_at: Date;
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
