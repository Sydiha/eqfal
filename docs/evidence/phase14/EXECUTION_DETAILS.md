# Phase 14 Recovered Execution Details

All results in this file are **historical**. They were recovered from Codex execution reports or checked-in evidence; none were rerun for this consolidation. The stated validation baseline is `b1579e6a0cf63d293ec88102869e4dbf48ebf269` unless a different SHA is explicitly listed.

## Automated suites

| Phase | Historical reported result | Scope and caveat |
|---|---|---|
| P1 | 8 files, 78 tests passed: first run 4 files/46; second 4 files/32. | `tenant-isolation.http.postgres.test.ts`, `tenant-id-tampering.http.postgres.test.ts`, `access-model.postgres.test.ts`, `draft-update-revisions.http.postgres.test.ts`, `historical-records.http.postgres.test.ts`, `invoice-approve.http.postgres.test.ts`, `settlement-closed-year.http.postgres.test.ts`, `journal-reversal.http.postgres.test.ts`. Disposable PostgreSQL 16; 110 migrations were applied. Some tenant tests accepted generic 4xx; exact response transcripts were not retained. |
| P2 | Latest combined automated run: 16 files, 136 tests passed. Separate temporary authenticated API suite: 1 file, 4 passed. | Covered document lifecycle/review, custody, bank statement reconciliation/allocation, personal payments, close policy/readiness, and asset/adjustment router contracts. Earlier overlapping runs included 9 files/116 pass plus one database-name guard failure, then an 11-file/83-pass rerun after correcting the disposable DB name. Do not add overlapping runs as independent coverage. |
| P2-Final | 17 files, 144 tests passed: 6 PostgreSQL files/81, 1 temporary authenticated API file/5, 10 router/contract files/58. | Includes document lifecycle, bank reconciliation/allocation, monthly close/readiness and route/contract suites. The temporary API test file was removed after execution. |

These per-run counts cannot be summed into a unique test count: P2/P2-Final intentionally repeated suites. The temporary P2/P2-Final test sources and raw test output are not available in the repository.

## Annual close, statements, carryforward, package approval

Recovered from “Verify Phase 14 annual close” (`01a1ba16-3030-72ba-95d7-50bce643d06a`):

- Annual readiness: FY2025 `ready: true`, `blocker_count: 0`; open receivable and payable balances both SAR 0.00; monthly-close policy `optional`; VAT return filed; Zakat-path workpaper approved while `calculation_performed: false`.
- Purchase: SAR 800 net + SAR 120 input VAT = SAR 920 payable. Sale: SAR 1,000 + SAR 150 output VAT = SAR 1,150 receivable.
- The SAR 1,150 collection and SAR 920 payment were created after year-end but carried FY2025 accounting dates (2025-12-20 and 2025-12-21 respectively). Readiness/package AR/AP were SAR 0.00.
- Trial Balance: debit and credit movements SAR 5,140.00 each; ending debit and credit balances SAR 2,150.00 each. Reported balances: bank 1,230; AR/AP 0; VAT input 120; VAT output 150; capital 1,000; revenue 1,000; expense 800.
- Financial position: assets 1,350 = liabilities 150 + equity 1,200; difference 0.
- Profit or loss: profit 200.
- Cash flow: operating 230, investing 0, financing 0; opening cash 1,000; closing cash 1,230; difference 0.
- Changes in equity: opening 1,000 + earnings 200 = closing 1,200; difference 0.
- Annual close: FY2025 close succeeded; duplicate close returned HTTP 409 `FISCAL_YEAR_ALREADY_CLOSED`.
- FY2026 carryforward: five opening items; debit/credit 1,350 each; assets 1,350; liabilities 150; equity 1,200; retained earnings 200; no revenue/expense balances carried; review was submitted, approved, and posted.
- Internal package: package AR/AP both 0; preview and final snapshots shared fingerprint `v2:f34e8dd9344f73ba44ae93010b4c27a0b3d937b90f4b50971484d1c2b16c48a7`; live fingerprint matched; package had no drift and reached internal `approved`. Reported audit counts: one each for package create/finalize/handoff/review/approve and two snapshot events.

The recovered summary does not preserve annual workflow source/journal IDs, the normal package ID, operator role/company ID, all timestamps, endpoint paths, or raw audit records. The year-end account values and results above are retained as reported; missing identifiers are not reconstructed.

## Auditor-package source-drift rejection

Recovered from the source-drift report in the same annual-close history:

- Package ID: `d8855a6b-235d-429f-975e-ecf4fd5b5db3`; package was finalized and handed off before the change.
- Authenticated `PUT /api/bank-reconciliation/settings` changed mode from `off` (version 0) to `warn` (version 1), changing the live fingerprint while the final snapshot stayed fixed.
- Stored fingerprint: `v2:1f3938a8e91288b16ae3d9e33efe7984e2e18466a9532c00a88bdbf0f67edc78`.
- Live fingerprint: `v2:d0b8c6df6cc225ed0af7bbbd5edf283497e20f994f19dd13ba875febfd44150a`; drift was true.
- Review returned HTTP 409, code `ANNUAL_PACKAGE_CHANGED_AFTER_FINALIZATION`.
- After rejection the package remained `handed_off`, version 3. The report states no `annual_package.reviewed` or `annual_package.approved` event existed at rejection time.
- Restoring mode to `off` (version 2) cleared drift; internal review/approval then succeeded. This is not external auditor certification.

The permitted settings change and result are recoverable from the report; full request/response logs and raw audit rows are not.

## P2-Final authenticated source workflows

Recovered from the P2-Final report in the “Validate authorization and tenant isolation” history (`01a1ba67-18d9-7345-8244-a2352c61805d`):

| Flow | IDs and reconciliation | HTTP / audit evidence reported |
|---|---|---|
| Document-linked expense | Document `3741bc56-a36a-4279-8e5e-cd31a0d6e03e` → obligation `15c6352a-8089-4b03-95d3-9bfa0ebe6d09` → journal `8e04d2c1-6cba-47bf-b3f2-699d5cd02d64`; Dr expense 80 = Cr payable 80. | Audit actions: document upload/intake/submit/approve, obligation create/update, journal create/lines.replace/post. A separate direct expense-to-journal endpoint is not claimed. |
| Bank CSV | Batch `a829d631-e4da-432c-9131-a9b05e10e223` → transaction `cf61d6c4-ed5f-4cad-8e83-699674061979` → document `6d043f8d-1a9b-4adb-b53d-06c1a2c56f22` → settlement `b42182dd-d790-4c15-b5b5-45037c3f69d3` → journal `ae4d648d-2db5-4800-94b4-4b15796aca0f`; transaction -60, settlement 60, Dr expense 60 = Cr bank 60. | Upload 201; duplicate upload 409; confirm 200; allocate 201; reconcile 200. Audit actions: `bank_import.confirm`, `bank_transaction.allocate/reconcile`, `document_settlement.create`, `journal.create/lines.replace/post`. |
| Asset/depreciation | Purchase document `f9d73032-c989-4545-af4e-ef8048b9c7bc` → asset `544e7f57-b578-41b4-9526-062ddc84b542` → depreciation source `f2ca4722-0c42-4ca5-b287-bd8907d1189f` → journal `08f24a07-ad09-4ab6-b4c0-3a7bbba6ca1b`; cost 1,200; schedule 12 × 100; posted period Dr depreciation expense 100 = Cr accumulated depreciation 100. | Duplicate asset registration 409; closed-period registration 409 `ACCOUNTING_PERIOD_CLOSED`. Audit: `asset.create.from_document`, `asset.approve`, `asset.depreciation.generate`, `journal.post`. Asset registration did not itself create an acquisition journal. |
| Periodic adjustments | Accrued expense source `7cce52a2-cfcf-4b30-a039-f4dbd5d048ae`, schedule `617c4a42-5c71-4014-8a5a-5dd4ee343db0`, journal `80b2c727-6f58-4417-80bd-dec81b7c2c40`; deferred income source `45376168-20ff-4562-89a2-8ac10a2845be`, schedule `fe598b5c-a7ad-46b6-858f-5594ee343db0`, journal `1fe73bdd-686a-465f-ad8b-fde4e264ee70`; each SAR 90 debit = credit. | Duplicate schedule post 409; closed-period create 409 `ACCOUNTING_PERIOD_CLOSED` with no adjustment row. Audit actions: create, submit, approve, schedule.post, journal.post. Reversal of these system-generated entries is not supported by the current product specification. |
| Monthly close | FY `01221c20-bb36-48bd-94d1-43943e31eb18`; period `8aefc194-1130-42fc-89bd-85adf1281862`, 2026-01-01 to 2026-01-31. | Close 200 and status `closed`; subsequent journal create 409 `ACCOUNTING_PERIOD_CLOSED`; audit `monthly_close.close`. |

## P2 historical scope

P2 reported document/evidence linkage, custody, CSV import, asset depreciation, prepayment, monthly-close policy, and closed-date controls across automated suites and temporary authenticated checks. Exact source IDs and full audit payloads were not preserved for those P2 scenarios. P2's separate 4-check temporary API suite is distinct from the reported 16-file/136-test automated suite; overlap prevents a reliable unique-case total.

## P1 authorization controls

P1's 78 passing tests reported:

- Tenant isolation and foreign-ID reads/writes refused; snapshots for the foreign company's rows remained unchanged.
- Authorized company-scoped access continued to work.
- Required capability denial and permitted invoice approval; unauthorized manual journal create/post returned 403.
- Stale-version conflicts returned 409 and left winning records intact.
- Closed fiscal-year/month writes returned 409; rejected actions left records/periods unchanged and did not write a successful-action audit row where asserted.

`access-model.postgres.test.ts` also exercised an authenticated manual journal create, lines replacement, unbalanced post refusal, balanced SAR 100 post, and `journal.post` audit count. The user had System Admin wildcard access for the authorized example; a standard Accountant-role UI workflow is not evidenced.
