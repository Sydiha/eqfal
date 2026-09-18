-- Phase 7C: conservative withholding-tax review workflow (no calculation or filing).
INSERT INTO capabilities (id) VALUES
 ('wht_review.view'),('wht_review.create'),('wht_review.edit'),('wht_review.submit'),('wht_review.review')
ON CONFLICT (id) DO NOTHING;

INSERT INTO role_capabilities(role_id,capability_id)
SELECT r.id,c.id FROM roles r CROSS JOIN (VALUES ('wht_review.view'),('wht_review.create'),('wht_review.edit'),('wht_review.submit'),('wht_review.review')) c(id)
WHERE LOWER(BTRIM(r.name))='admin' ON CONFLICT(role_id,capability_id) DO NOTHING;

CREATE TABLE wht_reviews (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
 fiscal_year_id UUID NOT NULL,
 source_type TEXT NOT NULL CHECK(source_type IN ('document','obligation','bank_transaction')),
 source_id UUID NOT NULL,
 counterparty_id UUID,
 non_resident_assessment TEXT NOT NULL CHECK(non_resident_assessment IN ('unknown','resident','non_resident')),
 payment_service_category TEXT NOT NULL CHECK(char_length(btrim(payment_service_category)) BETWEEN 1 AND 200),
 basis_reference TEXT NOT NULL CHECK(char_length(btrim(basis_reference)) BETWEEN 1 AND 2000),
 reviewer_note TEXT CHECK(reviewer_note IS NULL OR char_length(reviewer_note)<=2000),
 professional_review_required BOOLEAN NOT NULL DEFAULT TRUE,
 workflow_status TEXT NOT NULL DEFAULT 'needs_review' CHECK(workflow_status IN ('needs_review','submitted','reviewed')),
 assessment_result TEXT CHECK(assessment_result IS NULL OR assessment_result IN ('not_applicable','applicable')),
 prepared_by_user_id UUID NOT NULL REFERENCES users(id), prepared_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 reviewed_by_user_id UUID REFERENCES users(id), reviewed_at TIMESTAMPTZ,
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(id,company_id), UNIQUE(company_id,fiscal_year_id,source_type,source_id),
 FOREIGN KEY(fiscal_year_id,company_id) REFERENCES fiscal_years(id,company_id) ON DELETE RESTRICT,
 FOREIGN KEY(counterparty_id,company_id) REFERENCES counterparties(id,company_id) ON DELETE RESTRICT,
 CHECK((reviewed_by_user_id IS NULL)=(reviewed_at IS NULL)),
 CHECK(workflow_status='reviewed' OR reviewed_by_user_id IS NULL),
 CHECK(workflow_status<>'reviewed' OR assessment_result IS NOT NULL)
);
CREATE INDEX wht_reviews_company_year_idx ON wht_reviews(company_id,fiscal_year_id,created_at);
