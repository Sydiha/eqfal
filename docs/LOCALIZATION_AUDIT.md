# Localization audit coverage

Baseline: `913bd3355f14436726dfcf8ad537907c0d588440` (`main`). This audit reviewed the client route table and shared application shell, scanned reachable component rendering for inline bilingual strings and direct identifier/data output, compared the English and Arabic locale resources, and compared role/capability display paths with the centralized UI label helpers.

## Audited areas

The reachable routes reviewed were home, fiscal years, monthly close, annual closing, VAT, documents, banking, partners, obligations, accounting, opening balances, periodic adjustments, sales, purchases, invoice account mappings, fixed assets, company accounting profile, access administration, company management, source authority, historical records, audit log, and account settings. Shared UI review included navigation, company switching, dialogs, status badges, errors, confirmations, language switching, and export controls.

## Fixed

- Added a centralized role display helper. Built-in roles use existing `home.roleNames` translations; custom role names fall back unchanged. Applied it to access role selectors, role lists, confirmations, system administration selectors, user details, and the current administrator note.
- Changed fixed asset and invoice account mapping displays to use the existing `localizedAccountName` helper. The helper prefers the active language, then the other localized field, then the preserved legacy value.
- Added missing bilingual labels for source-authority and additional system capability identifiers, plus an Arabic-readable fallback for capability IDs that do not have a natural-language override. The capability test fixture now covers all 182 distinct IDs declared by migration `INSERT INTO capabilities` statements.
- Moved shared shell labels, navigation destinations, and navigation group titles into the existing English and Arabic locale resources.
- Added tests for built-in/custom role display, English-to-Arabic message-key coverage, shared shell key coverage, and preserved the existing language direction/persistence, capability, and bilingual accounting-account tests.

## Verified without changes

- The app uses one `i18next` instance, persists language through `eqfal-lang`, sets document `lang` and `dir`, and synchronizes Mantine direction on language changes.
- English and Arabic resources include all 2,478 English leaf keys (the reverse set includes Arabic plural-form variants handled by i18next). The focused capability fixture checks 182 migration-defined IDs.
- Accounting chart and periodic adjustment displays already use the bilingual account helper. User-entered company and partner/accounting names remain source data and are not machine-translated.
- Existing date and amount display paths generally apply explicit locale/direction formatting; values remain unchanged in requests and storage.

## Remaining limitations

- Some module copy is still maintained as component-local Arabic/English constants instead of locale resource keys. This pass prioritized system-wide shared controls, roles/permissions, and financial account display; it does not establish exhaustive per-string localization coverage.
- Exact account-name endpoint limitation: `GET /api/invoice-account-mappings` selects `a.name` and `a.name_ar` for mapped and eligible accounts but omits `a.name_en`; the English screen therefore displays the legacy `name`, which may itself contain Arabic. `GET /api/zakat-worksheets/:fiscalYearId` snapshots account `name` and `name_ar` in `captureBalances()` and drops `name_en` even though the financial-position source includes it; the English worksheet likewise displays legacy `name`. Accounts returned by `/api/accounts` with `name_en` are localized through `localizedAccountName` (including fixed-asset account selectors). No financial name was translated, inferred, or overwritten. These two response paths were left unchanged to preserve backend contracts.
- The full client suite previously failed only at `ReportExport.test.tsx`'s whole-HTML equality assertion; isolated execution passed. The assertion was sensitive to locale-dependent markup while a print portal was open. The test now deterministically changes locale during printing and verifies rows, account data, selected report side, and request count instead of requiring identical HTML.
- Static source review and automated tests do not replace visual UAT of every route in both directions, including narrow/mobile layouts, dialogs, and exports.
