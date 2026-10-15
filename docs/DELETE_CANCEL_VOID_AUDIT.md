# Delete, Cancel & Void — module audit (Phase 3)

Baseline: `main` at `1771658`. Phases 1 (#444 invoices) and 2 (#445 documents) are not repeated here.
Rule applied everywhere: DRAFT → delete; SUBMITTED → return to draft / cancel; APPROVED → cancel or correcting document; POSTED / SETTLED / closed period → never deleted, reversal only where an accounting model already exists. Where it does not, the protection stays and the gap is listed below.

## Implemented in Phase 3 (migration 079, `modules/record-deletion`)
| Module | Operation | Allowed when | Capability |
|---|---|---|---|
| Accounting | Delete manual draft journal | status `draft`, no operational source, standard entry, open period, nothing references it | `accounting.journal.delete` |
| Accruals / prepayments | Delete draft | `workflow_status = draft`, open period, no schedule/journal | `periodic_adjustment.delete` |
| Banking | Delete unconfirmed import batch (file removal via the shared durable `storage_deletion_queue`, retried automatically) | `mapping_required` / `preview_ready` (no transactions exist) | `bank.import.delete` |
| Receivables/payables | Delete customer/supplier | referenced by no table (FK catalog scan), version check | `counterparty.delete` |
| Partners | Delete partner | no ownership history / other reference, version check | `partner.delete` |

Each: own capability registered with **no role grant** (Full Access / System Admin hold it through the wildcard), classified `sensitive`; company-scoped `FOR UPDATE` lock in one transaction; pre-delete snapshot in `audit_log`; `409` with a machine-readable `reason` shown in AR/EN; confirmation dialog stating the deletion is permanent.

Migration 079 also fixes `protect_posted_journal()` (021): it ended with `RETURN NEW`, which is NULL in a BEFORE DELETE trigger, so deleting a draft journal silently removed nothing. A posted journal still raises `55000` for UPDATE and DELETE; only the non-posted DELETE path returns `OLD`.

## Existing operations reused (no change)
Invoices: delete draft (#444), return to draft, cancel (draft/submitted), credit/debit note cancel. Documents: delete unprocessed (#445). Obligations: cancel (`is_cancelled`), remove settlement. Counterparties/partners: deactivate. Bank: unmatch transaction; custody return/allocation removal, close/reopen. Document settlements: remove. Fixed assets: cancel, dispose. Periodic adjustments: return to draft. Opening balances: item delete, return to draft. Tax working papers: adjustment delete. VAT periods: reopen. Monthly close: reopen. Recurring invoices: pause / resume / end.

## Not implemented — blockers (protection kept)
1. **Reversal of a POSTED journal** — no reversing-entry model exists (no reversal link, no reversal numbering/period rules). Needs a design decision; posted journals stay immutable.
2. **Cancel / void an approved invoice's journal and obligation** — approved invoices are corrected by credit/debit notes (existing); a void with accounting effect needs the same decision as (1).
3. **Reverse a posted accrual/prepayment schedule line or fixed-asset depreciation / disposal** — accounting reversal of depreciation or recognition is policy (depreciation logic is out of scope); only cancel (draft assets) exists.
4. **Confirmed bank import / reconciled transactions** — transactions feed settlements and matches; "undo import" would need a controlled reversal model. Unmatch already exists.
5. **VAT adjustments, VAT returns, WHT reviews** — draft deletion is technically possible but changes tax-readiness inputs; left for an explicit tax-policy decision. Filed/closed periods stay protected.
6. **Partner ownership periods, fiscal years, company profile / accounting profile versions, accounts (chart)** — referenced history or period/identity records; deactivate/edit-with-reason only. Company logo delete already exists.
7. **Collections / payments** — there is no separate collections entity; they are bank-transaction settlements (removable via the existing settlement removal, subject to period locks).
