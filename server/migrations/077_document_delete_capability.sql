-- Migration 077 (Delete & Void Phase 2): registers document.delete, the capability to permanently delete an unprocessed document and its stored file.
-- Registration only. No role_capabilities row is inserted, so no default role (Viewer, Accountant, Finance Manager, Company Manager) gains it;
-- Full Access holds it through the wildcard like every registered capability (migration 075).
-- No table or trigger changes: every foreign key to documents is RESTRICT or NO ACTION except the two evidence-link tables (CASCADE), and the service
-- refuses deletion whenever any such reference exists (see DocumentService.deleteDocument), so nothing cascades into invoices or financial records.
-- Rollback: DELETE FROM capabilities WHERE id = 'document.delete' (cascades any explicit grants).

INSERT INTO capabilities (id) VALUES ('document.delete')
ON CONFLICT (id) DO NOTHING;
