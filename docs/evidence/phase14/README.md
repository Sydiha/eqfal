# Phase 14 Evidence Consolidation

## Scope and provenance

This package consolidates existing Phase 14 evidence. It does not report new test or workflow executions.

- **Product baseline:** `main@b1579e6a0cf63d293ec88102869e4dbf48ebf269`.
- **Matrix design baseline:** `8f17258df221d15919e56487721f7d087d0a77e9` (see matrix §2). The evidence in this package targets the later product baseline; both SHAs are retained.
- **Current matrix:** [`../../PHASE_14_FULL_CYCLE_VALIDATION_MATRIX.md`](../../PHASE_14_FULL_CYCLE_VALIDATION_MATRIX.md).
- **Recovered reports:** Codex history titled “Validate authorization and tenant isolation” (`01a1ba67-18d9-7345-8244-a2352c61805d`) and “Verify Phase 14 annual close” (`01a1ba16-3030-72ba-95d7-50bce643d06a`), including their P1/P2/P2-Final and annual-close/source-drift results. These are historical reports, not repository test logs.
- **Existing durable records:** matrix §9; [`../t7/T7_3_OPENING_BALANCE_IMPORT_VALIDATION_d2c32d4.md`](../t7/T7_3_OPENING_BALANCE_IMPORT_VALIDATION_d2c32d4.md), [`../t7/T7_4_OPENING_BALANCE_E2E_UAT_d2c32d4.md`](../t7/T7_4_OPENING_BALANCE_E2E_UAT_d2c32d4.md), `../t7/tb.json`, `../t7/ob.csv`, and Issue #286 evidence referenced in matrix §9.

The historical reports state the exact required SHA. Temporary databases, worktrees, and raw terminal/API output were removed after those runs. A report is evidence that the workflow was reported successful at that baseline; it is not a fresh run, nor a substitute for missing raw records.

## Proposed current assessment

| Status | Number of rows | Rows |
|---|---:|---|
| PASS | 1 | 5 |
| PARTIAL | 23 | 1–4, 6–24 |
| NOT RUN | 0 | — |
| BLOCKED | 0 | — |

Cross-cutting 14H is **PARTIAL** and reported separately from the 24 numbered rows.

These statuses distinguish functional success from strict matrix acceptance. Several workflows that older matrix notes called NOT RUN have later authenticated historical evidence. They are now PARTIAL because section 6 evidence fields remain incomplete; they are not being represented as unexecuted or as PASS. Row 5 retains its existing PASS because matrix §9 cites the Issue #286 row-level evidence.

## Package contents

- [`ROW_EVIDENCE.md`](ROW_EVIDENCE.md) — row-by-row evidence index, proposed status, and missing acceptance fields.
- [`EXECUTION_DETAILS.md`](EXECUTION_DETAILS.md) — recovered historical test counts, authenticated workflow results, reconciliations, IDs, HTTP errors, and audit actions where reports preserve them.
- [`OWNER_UAT.md`](OWNER_UAT.md) — limited manager-facing Owner UAT checklist for a synthetic test environment.

## Unrecoverable details

The prior reports and repository files do not preserve all of the following:

- Raw test-run logs, temporary API test source, database snapshots, and full request/response transcripts from P1/P2/P2-Final and annual-close runs.
- Per-action timestamps, acting user IDs/roles, and active company IDs for most temporary operational runs.
- Source, journal, and audit entity IDs for annual sale/purchase/collection/payment and custody examples; the recovered annual report gives amounts and workflow outcomes but not those IDs.
- The normal approval package's package ID and raw audit rows; the separate drift-rejection package ID and fingerprints are preserved in the historical report.
- Event-level audit payloads, before/after snapshots, and exact failure codes for every rejected mutation across all runs.
- Full endpoint paths for each financial-statement response, and exact query/response bodies beyond the values summarized in the annual report.
- A count of distinct test cases after deduplicating suites rerun across P1/P2/P2-Final. Reported per-run counts must not be summed as unique coverage.

These fields remain marked missing in the row index. Do not reconstruct or guess them from fixtures or current code.

## Acceptance position

Phase 14 remains open pending evidence completion and Owner UAT. No product defect was confirmed in the recovered reports. The main remaining issue is incomplete durable, row-level evidence and manager-facing UAT, rather than a missing positive functional run for sale, VAT, statements, carryforward, annual close, or package drift rejection.
