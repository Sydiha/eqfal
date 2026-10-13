# Invoice corrections (F4): what is implemented and what is blocked

Status: draft/submitted cancellation and registration of EXTERNALLY issued credit/debit notes implemented (migration 072, not applied anywhere). EQFAL registers notes; it does not issue them (no e-invoice, no ZATCA XML, no refunds). The rest below is **blocked on Owner accounting/tax decisions**.

## Implemented
- `POST /api/invoices/:id/cancel` (`invoice.cancel`, explicit-grant-only, migration 071; no grants are created).
- Allowed only for `draft` and `submitted` invoices (no number, obligation, journal or VAT snapshot exist yet). Reason is mandatory (1-500 chars); optimistic version check; audit event `invoice.cancel`; the row, lines and history are kept.
- Refused with `INVOICE_CANCEL_NOT_ALLOWED` for approved invoices (and for any invoice that already has an obligation or VAT snapshot); `INVOICE_ALREADY_CANCELLED` for a cancelled one.
- Read model adds `cancellation` and `adjustments` (read-only list of linked credit/debit notes) for the correction-history panel.

## Implemented: external credit/debit notes (migration 072)
- Capabilities `invoice.adjust` (register/edit/cancel a draft) and `invoice.adjust_approve` (approve), explicit-grant-only, no grants created. Approval also needs `obligation.confirm` + `accounting.journal.create`; the registrant can never approve (service and DB trigger).
- Routes: `GET/POST /api/invoices/:id/adjustments`, `GET/PUT /api/invoice-adjustments/:id`, `POST /api/invoice-adjustments/:id/cancel|approve`. VAT and totals are computed server-side from net and rate (exact halalas); the client sends no amounts.
- Original invoice must be approved with a POSTED journal. Original invoice, lines, obligation, journal, VAT snapshot and settlements are never touched. Approval creates a separate DRAFT journal (credit = mirror of the invoice journal, debit = same direction), posted via the normal posting flow, whose VAT lines are verified against the approved note.
- Outstanding/adjusted amounts are derived on the SAME obligation (no second receivable/payable): invoice read model, aging, obligation lists, snapshot, home alerts, monthly close and the settlement trigger all use `original +/- approved notes`.
- Purchases: recoverability stated per standard line (full / partial with percent / none); non-recoverable VAT is booked in the expense; recoverable credited VAT may not exceed what remains on the original.
- Duplicate external number refused per counterparty (case-insensitive, draft and approved); a cancelled draft frees it. Supporting document link is exclusive.
- VAT reporting: approved notes appear in VAT reconciliation, closing report and XLSX by note date (credit reduces output/input VAT).

### Blocked by design (error codes, no guessing)
- `INVOICE_ADJUSTMENT_VAT_PERIOD_UNSUPPORTED`: note date and original tax point must fall in the SAME existing open VAT period; anything else would need an amended VAT return. `INVOICE_VAT_PERIOD_CLOSED`, `INVOICE_PERIOD_CLOSED`, `INVOICE_FISCAL_YEAR_CLOSED` also block.
- `INVOICE_ADJUSTMENT_GROUP_UNSUPPORTED`: a treatment/rate group that does not exist on the original invoice.
- `INVOICE_ADJUSTMENT_EXCEEDS_ORIGINAL` / `_EXCEEDS_OUTSTANDING`: credit above the original per VAT group (cumulative) or above the outstanding balance (credit balances and refunds are not supported).
- Not implemented: note numbering series, cancelling an approved note (needs a reversal decision), notes on unposted invoices, asset purchases.

## Blocked (do not implement without a decision)
1. **Cancel an approved, not-yet-posted invoice.** Needs changes to the guards on `obligations`, the draft journal lines and the immutable VAT snapshot (migrations 065/066), and a rule for how the cancelled invoice's VAT snapshot appears in VAT reports and reconciliation (a change to tax reporting). Decision needed: allow it at all? If yes, treatment of the draft journal and snapshot.
2. **Cancel a posted invoice.** Owner rule (migration 062 note): never directly. Correction = credit/debit note + reversal.
3. **Releasing the evidence document of a cancelled invoice** (`invoice_source_links` is unique per document and non-draft links cannot be removed). Cancelled draft/submitted invoices keep the link; the document stays usable for its own recognition (the recognition guard only blocks submitted/approved invoices).
