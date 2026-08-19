-- Phase 7A1: tenant-scoped double-entry accounting ledger foundation.
INSERT INTO capabilities (id) VALUES
  ('accounting.view'),
  ('accounting.chart.manage'),
  ('accounting.journal.manage'),
  ('accounting.journal.post')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('asset','liability','equity','revenue','expense')),
  parent_account_id UUID,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, company_id),
  UNIQUE (company_id, code),
  FOREIGN KEY (parent_account_id, company_id) REFERENCES accounts(id, company_id) ON DELETE RESTRICT,
  CHECK (length(btrim(code)) BETWEEN 1 AND 50),
  CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  CHECK (parent_account_id IS NULL OR parent_account_id <> id)
);
CREATE INDEX accounts_company_code_idx ON accounts(company_id, code);

CREATE TABLE journal_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  fiscal_year_id UUID NOT NULL,
  accounting_date DATE NOT NULL,
  description TEXT NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 500),
  reference TEXT CHECK (reference IS NULL OR length(reference) <= 200),
  source_type TEXT CHECK (source_type IS NULL OR length(source_type) BETWEEN 1 AND 100),
  source_id UUID,
  entry_type TEXT NOT NULL DEFAULT 'standard' CHECK (entry_type IN ('standard','opening_balance')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted')),
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  posted_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, company_id),
  FOREIGN KEY (fiscal_year_id, company_id) REFERENCES fiscal_years(id, company_id) ON DELETE RESTRICT,
  CHECK ((source_type IS NULL) = (source_id IS NULL)),
  CHECK ((status='draft' AND posted_by IS NULL AND posted_at IS NULL) OR
         (status='posted' AND posted_by IS NOT NULL AND posted_at IS NOT NULL))
);
CREATE UNIQUE INDEX journal_entries_source_uidx ON journal_entries(company_id, source_type, source_id)
  WHERE source_type IS NOT NULL;
CREATE INDEX journal_entries_company_date_idx ON journal_entries(company_id, accounting_date, id);

CREATE TABLE journal_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  journal_entry_id UUID NOT NULL,
  account_id UUID NOT NULL,
  debit NUMERIC(18,2) NOT NULL DEFAULT 0,
  credit NUMERIC(18,2) NOT NULL DEFAULT 0,
  memo TEXT CHECK (memo IS NULL OR length(memo) <= 500),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, company_id),
  UNIQUE (journal_entry_id, sequence),
  FOREIGN KEY (journal_entry_id, company_id) REFERENCES journal_entries(id, company_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, company_id) REFERENCES accounts(id, company_id) ON DELETE RESTRICT,
  CHECK (debit >= 0 AND credit >= 0),
  CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0))
);
CREATE INDEX journal_lines_entry_idx ON journal_lines(company_id, journal_entry_id, sequence);
CREATE INDEX journal_lines_account_idx ON journal_lines(company_id, account_id);

-- Database-level historical immutability complements transactional row locks in the service.
CREATE FUNCTION protect_posted_journal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'posted' THEN RAISE EXCEPTION 'posted journal is immutable' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_entries_posted_immutable BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION protect_posted_journal();

CREATE FUNCTION protect_posted_journal_lines() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE entry_status TEXT;
BEGIN
  SELECT status INTO entry_status FROM journal_entries
    WHERE id=COALESCE(OLD.journal_entry_id, NEW.journal_entry_id)
      AND company_id=COALESCE(OLD.company_id, NEW.company_id);
  IF entry_status='posted' THEN RAISE EXCEPTION 'posted journal is immutable' USING ERRCODE='55000'; END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER journal_lines_posted_immutable BEFORE INSERT OR UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION protect_posted_journal_lines();
