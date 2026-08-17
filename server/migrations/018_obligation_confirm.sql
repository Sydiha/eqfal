-- Phase 4C: confirmation is an independent capability and is not granted to any role.
INSERT INTO capabilities (id) VALUES ('obligation.confirm') ON CONFLICT (id) DO NOTHING;
