-- Wave A / A1: action-specific document intake and submission capabilities.
-- Preserve every legacy upload grant while making runtime authorization granular.

INSERT INTO capabilities (id)
VALUES
  ('document.edit'),
  ('document.submit')
ON CONFLICT (id) DO NOTHING;

INSERT INTO role_capabilities (role_id, capability_id)
SELECT rc.role_id, granular.id
FROM role_capabilities rc
CROSS JOIN (
  VALUES
    ('document.edit'),
    ('document.submit')
) AS granular(id)
WHERE rc.capability_id = 'document.upload'
ON CONFLICT (role_id, capability_id) DO NOTHING;
