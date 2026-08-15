-- Migration 010: company-scoped document review workflow

ALTER TABLE documents
  ADD COLUMN reviewed_by_user_id UUID REFERENCES users(id),
  ADD COLUMN reviewed_at TIMESTAMPTZ,
  ADD COLUMN review_note TEXT CHECK (review_note IS NULL OR char_length(review_note) <= 500);

INSERT INTO capabilities (id)
VALUES ('document.review'), ('document.approve')
ON CONFLICT (id) DO NOTHING;
