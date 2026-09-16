-- Dedicated company-scoped access-administration authority. Full Access roles
-- continue to receive every capability dynamically; no ordinary role is
-- granted this capability by default.
INSERT INTO capabilities (id) VALUES ('access.manage') ON CONFLICT (id) DO NOTHING;
