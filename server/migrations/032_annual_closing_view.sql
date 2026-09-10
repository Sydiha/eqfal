-- Phase 7A: read-only Annual Closing Center access.
INSERT INTO capabilities (id) VALUES ('annual_close.view') ON CONFLICT (id) DO NOTHING;
