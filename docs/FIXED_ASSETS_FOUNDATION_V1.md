# Fixed Assets Foundation V1

## Delivered scope

Fixed Assets Foundation V1 adds tenant-scoped asset categories, a fixed-asset register, explicit approved-purchase capitalization, controlled manual/opening assets, draft approval and cancellation, deterministic straight-line monthly depreciation, accumulated depreciation and net book value, disposal records and gain/loss calculation, accounting operational sources, monthly-close readiness blockers, capabilities, audit events, and a functional Arabic/English workspace.

The implementation reuses the existing accounting operational-source and journal workflow. Purchase accounting is not repeated by asset capitalization. Depreciation becomes posted only when its linked journal is posted. Mutations use the active-company context, Same-Origin middleware, transactions/locking, and the existing closed-period guard.

## Migration

`server/migrations/024_fixed_assets_foundation.sql` creates `asset_categories`, `fixed_assets`, `asset_depreciation_entries`, and `asset_disposals`; seeds the eight initial categories for current and future companies; installs asset capabilities; and adds tenant relationship, uniqueness, status, value, and posted-source guards.

## Deliberately deferred

All items identified as out of scope by the approved contract remain deferred, including physical inventory/tagging, component and multiple-book accounting, tax depreciation, impairment/revaluation, advanced depreciation/proration, transfers, maintenance, insurance, custody, advanced imports, and automatic purchase classification.

## Validation and delivery

Validation uses the repository's official `typecheck`, `test`, and `build` scripts plus focused fixed-assets foundation tests. The implementation began from externally verified `main` SHA `312edab3784996dd0b3e4d71bb7b06c86e1a9338`. The Codex checkout could not fetch or authenticate to GitHub; a PR reference is recorded only if delivery becomes technically available.
