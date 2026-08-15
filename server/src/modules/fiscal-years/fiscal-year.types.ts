export type FiscalYearStatus = 'open' | 'closed';

export interface FiscalYear {
  id: string;
  company_id: string;
  name: string;
  /** ISO date string — 'YYYY-MM-DD' */
  start_date: string;
  /** ISO date string — 'YYYY-MM-DD' */
  end_date: string;
  status: FiscalYearStatus;
  created_at: Date;
  updated_at: Date;
}

export interface CreateFiscalYearInput {
  company_id: string;
  name: string;
  start_date: string;
  end_date: string;
}

/** All fields optional — only supplied fields are updated. */
export interface UpdateFiscalYearInput {
  name?: string;
  start_date?: string;
  end_date?: string;
}
