export interface Company {
  id: string;
  slug: string;
  name: string;
  name_ar: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface CreateCompanyInput {
  slug: string;
  name: string;
  name_ar?: string;
}
