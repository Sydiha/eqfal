-- Migration 076 (Delete & Void Phase 1): registers invoice.delete, the capability to physically delete a DRAFT sales or purchase invoice.
-- Registration only. No role_capabilities row is inserted, so no default role (Viewer, Accountant, Finance Manager, Company Manager) gains it;
-- Full Access holds it through the wildcard like every registered capability (migration 075).
-- No table, trigger or guard changes: the invoices/invoice_lines/invoice_source_links guards from 062 already allow deleting drafts only.
-- Rollback: DELETE FROM capabilities WHERE id = 'invoice.delete' (cascades any explicit grants).

INSERT INTO capabilities (id) VALUES ('invoice.delete')
ON CONFLICT (id) DO NOTHING;
