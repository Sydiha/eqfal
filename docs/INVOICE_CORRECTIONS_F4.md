# Invoice corrections (F4): what is implemented and what is blocked

Status: draft/submitted cancellation implemented. Everything else below is **blocked on Owner accounting/tax decisions**; no code for it exists.

## Implemented
- `POST /api/invoices/:id/cancel` (`invoice.cancel`, explicit-grant-only, migration 071; no grants are created).
- Allowed only for `draft` and `submitted` invoices (no number, obligation, journal or VAT snapshot exist yet). Reason is mandatory (1-500 chars); optimistic version check; audit event `invoice.cancel`; the row, lines and history are kept.
- Refused with `INVOICE_CANCEL_NOT_ALLOWED` for approved invoices (and for any invoice that already has an obligation or VAT snapshot); `INVOICE_ALREADY_CANCELLED` for a cancelled one.
- Read model adds `cancellation` and `adjustments` (read-only list of linked credit/debit notes) for the correction-history panel.

## Blocked (do not implement without a decision)
1. **Cancel an approved, not-yet-posted invoice.** Needs changes to the guards on `obligations`, the draft journal lines and the immutable VAT snapshot (migrations 065/066), and a rule for how the cancelled invoice's VAT snapshot appears in VAT reports and reconciliation (a change to tax reporting). Decision needed: allow it at all? If yes, treatment of the draft journal and snapshot.
2. **Cancel a posted invoice.** Owner rule (migration 062 note): never directly. Correction = credit/debit note + reversal.
3. **Credit/debit notes** (`invoice_adjustments` has a table only). Decisions needed before any code:
   - VAT effect period: the note's period vs the original tax period; behaviour when the original VAT period is closed (`vat_adjustments` link only to documents today).
   - Over-crediting beyond the outstanding balance (credit balance/refund representation): the design says to block in v1; confirm.
   - Journal source amount rule for notes, purchase-side input VAT recoverability on notes (V2.1 splits), numbering series for notes, and who approves (new `invoice.adjust` capability, separation of duties).
   - Settlement interaction: a note on a partly settled invoice (reduces outstanding; never creates an automatic refund).
4. **Releasing the evidence document of a cancelled invoice** (`invoice_source_links` is unique per document and non-draft links cannot be removed). Cancelled draft/submitted invoices keep the link; the document stays usable for its own recognition (the recognition guard only blocks submitted/approved invoices).
