# EQFAL — Approved Execution Roadmap

Status: Approved project guidance
Date: 2026-09-06

## Permanent delivery rules

- GitHub `main` is the sole source of truth for merged project state.
- One bounded task at a time.
- Every implementation task begins with a read-only design check; no coding before approval.
- After design approval, use one complete implementation contract for Codex whenever practical.
- Avoid iterative prompt loops and unnecessary context transfer. Prefer changed files, focused diffs, targeted tests, and CI evidence.
- One corrective implementation pass is allowed for a real acceptance blocker. If a second corrective pass would be required, stop and revisit the design instead of spending more Codex tokens/credits.
- No Production changes without explicit approval.
- No Replit Agent.
- Replit Runtime/Preview is only for exceptional manual/practical validation when needed.
- No paid service, new operating cost, paid API, extra server, extra database, paid storage, paid OCR, SMS/WhatsApp service, or other paid dependency without explicit prior approval.
- Prefer the existing application/database/infrastructure whenever they can satisfy the requirement safely.
- If a proposed capability may create new recurring or usage-based cost, stop and surface the expected cost before implementation.
- Complete the system functionally and accounting-wise before system-wide UI/UX redesign.
- UI/UX changes before that point are limited to functional blockers or usability defects that prevent correct operation.
- The project owner/operator is treated as a non-accountant. EQFAL must not require a non-accountant to make unexplained professional accounting/tax judgments.
- Roles are templates; effective capabilities are authoritative and company-scoped. Backend authorization remains authoritative.
- Sensitive changes require auditability and controlled effective dates where relevant.

## Permanent Codex ↔ GitHub delivery preflight

Before any programming task, run a read-only delivery preflight and prove all of the following:

1. Codex is operating on the correct repository: `Sydiha/eqfal`.
2. The workspace/repository has the correct Git remote and `origin` points to `Sydiha/eqfal`.
3. GitHub authentication/connector credentials are available to the execution environment.
4. The environment can read the repository, create/switch a branch, commit, push, and create/update a pull request.
5. Record the exact baseline SHA from `main` before implementation.
6. Work only on a dedicated branch; never write implementation changes directly to `main`.
7. If remote is missing, connector/authentication is unavailable, repository access is read-only, push is impossible, or PR creation is unavailable: stop before editing code.
8. Do not repeat the previous failure mode where implementation is completed locally and only afterward delivery to GitHub is discovered to be impossible.
9. Corrective work stays on the same PR.
10. Acceptance requires review of the real GitHub diff, changed files, tests/CI on the exact head SHA, and comparison against the approved design check. A Codex summary alone is not acceptance evidence.

## Codex token / credit conservation policy

- Use Codex for implementation when the task is already designed and bounded, not for open-ended project discussion.
- Do not resend the entire project history for every task.
- Prefer repository reads and focused file references over manual copying of large files/logs.
- Prefer one complete implementation prompt containing goal, scope, constraints, acceptance criteria, required tests, and explicit out-of-scope items.
- Prefer targeted tests for local changes; run broader suites only when the risk justifies them or CI already provides them.
- Rely on GitHub PRs and CI as durable state transfer instead of repeated manual artifact relay.
- Avoid repeated Codex review loops. If implementation quality is uncertain, improve the design contract before starting.

## Phase 0 — Project reference and accounting/compliance governance

- Keep the Saudi accounting/tax compliance roadmap in project documentation.
- Treat the owner/manager as a non-accountant operator.
- EQFAL records operational truth, links evidence, applies deterministic controls, surfaces gaps, and routes material professional judgments to an authorized accountant/reviewer.
- UI/API success alone does not prove accounting completeness.
- Record material accounting/compliance gaps before a capability is called complete.
- 2026 remains the first live year; historical/opening balances are handled through a controlled review process.

## Phase 1 — Company Accounting & Tax Profile

Create a company-scoped governing profile that determines which accounting/tax controls apply.

### Accounting framework
- IFRS.
- IFRS for SMEs.
- Other / accountant-reviewed.
- Review/approval state and effective date.

### Fiscal profile
- Fiscal year start.
- Fiscal year end.
- Functional currency.
- First live accounting date in EQFAL.

### VAT profile
- Registered / not registered.
- VAT registration number.
- Registration effective date.
- Filing frequency: monthly / quarterly.
- Registration status and deregistration effective date when relevant.

### Zakat / Income Tax profile
- Zakat applicable.
- Income tax applicable.
- Mixed ownership / mixed treatment.
- Saudi / non-Saudi ownership indicators where relevant.
- Effective dates.
- Accountant notes/review state.

### Withholding Tax profile
- Applicable / not applicable / needs review.
- Whether relevant non-resident dealings/payments exist.
- Accountant review when professional judgment is required.

### Governance
- Draft.
- Needs accountant review.
- Reviewed.
- Approved.
- Effective.
- Prepared by / reviewed by / approved by.
- Effective-from date.
- Change reason.
- Version/audit history.
- Sensitive changes create a new effective-dated version rather than silently overwriting prior history.
- Do not retroactively rewrite closed periods automatically. Any change affecting a closed period must surface for accountant review and controlled reopen/corrective treatment where necessary.

### Capabilities
- `company_accounting_profile.view`
- `company_accounting_profile.manage`
- `company_accounting_profile.review`
- `company_accounting_profile.approve`

### Explicitly deferred
- E-invoicing / Fatoora scope and integration are not required now and are deferred to a future phase if the business later needs them.

## Phase 2 — Fixed Asset Depreciation Policy

- Complete the current Fixed Assets foundation with governed category-level depreciation policy.
- Method.
- Annual rate and/or useful life with a consistent relationship.
- Prevent contradictory rate/life settings.
- Residual value.
- Acquisition, placed-in-service, and depreciation-start dates remain distinct.
- Asset, accumulated-depreciation, and depreciation-expense accounts.
- Effective date, review, approval, and policy history.
- Preserve prior-period interpretation; no silent retroactive rewrite.
- Persistent monthly schedule, decimal-safe amounts, opening accumulated depreciation, NBV controls.
- Posting integration, duplicate-posting prevention, close blockers for required unposted depreciation.
- Disposal / sale / scrap-write-off and gain/loss treatment.
- Advanced impairment, revaluation, components, multiple books, tax depreciation, and similar advanced features remain deferred until proven necessary.

## Phase 3 — Opening Balance Review

- Banks.
- Receivables/customers.
- Payables/suppliers and obligations.
- Fixed assets and opening accumulated depreciation.
- Loans/other liabilities.
- Equity/partners.
- VAT/tax balances where relevant.
- Other material balances.
- Evidence/source, date, confidence, notes, review and approval.
- Controlled opening journal without duplication against historical/imported operational data.
- Do not treat a bank balance alone as a valid opening financial position.

## Phase 4 — Accruals, Prepayments and Periodic Adjustments

- Accrued expenses.
- Prepaid expenses.
- Accrued income.
- Deferred/unearned income.
- Period allocation schedules.
- Initial, recurring and reversing entries where appropriate.
- Link to document/contract/obligation where available.
- Accountant review/approval when required.
- Monthly Close integration.

## Phase 5 — Chart Classification and Financial Statement Mapping

- Expand chart classification where necessary: current/non-current assets, contra-assets, current/non-current liabilities, equity, revenue, cost of sales when applicable, operating expenses, finance and other income/expense as needed.
- Map accounts to financial statement presentation.
- Statement of Financial Position.
- Profit or Loss.
- Changes in Equity.
- Cash Flows when prerequisite data is complete.
- Reports derive from the ledger rather than independent manual numbers.
- Do not present profitability/cash-flow KPIs as final before the underlying accounting cycle is complete.

## Phase 6 — VAT Reconciliation Hardening

- Company VAT profile becomes authoritative.
- Non-registered companies are not forced through VAT controls.
- Registered companies follow effective registration date and filing frequency.
- Standard, zero-rated, exempt and out-of-scope treatment.
- Input/output VAT reconciliation to reviewed documents and ledger postings.
- Differences, missing evidence, adjustments, credit/debit notes, close protection, filing-period working papers and readiness.
- Do not assume all purchase VAT is recoverable automatically.
- Professional tax judgments remain reviewable by the authorized accountant/adviser.

## Phase 7 — Zakat, Income Tax and Withholding Tax

- Company applicability profile drives the workflow.
- Saudi/non-Saudi/mixed ownership context where relevant.
- Effective ownership/tax-profile changes.
- Zakat/tax working papers and reconciliations tied to financial statements.
- Withholding-tax review for relevant non-resident payments.
- EQFAL prepares, reconciles, explains and surfaces exceptions; it does not replace final professional tax judgment.

## Phase 8 — Integrated Monthly Close

Monthly Close becomes company-aware and only enforces controls applicable to that company.

Evaluate, as relevant:
- incomplete/unreviewed documents;
- unconfirmed obligations;
- unmatched bank transactions;
- unposted operational/accounting sources;
- independent draft/unposted journals;
- VAT readiness;
- required depreciation and document-backed asset drafts;
- accruals/prepayments and periodic adjustments;
- opening-balance review during transition periods;
- other configured close requirements.

For each blocker show plain-language reason, effect, who can resolve it, whether accountant review is required, and a direct navigation target.

Close locks the period. Reopen requires a separate capability, mandatory reason and audit trail.

## Phase 9 — Final Permission Model

- Role = convenience template only.
- Effective user/company capabilities are authoritative.
- Separate view, create, edit, review, approve, post, cancel, reopen, policy-management and user/permission administration where appropriate.
- A company manager may have more or fewer capabilities than another company manager.
- Backend enforcement is authoritative; hiding UI controls is not security.
- Grant Ceiling: users cannot grant more authority than they possess.
- Audit every permission change.
- Permission-copying may be added later with a diff preview before confirmation if proven useful.

## Phase 10 — Company Manager Workspace

The manager may, according to capability, record operational reality and review company state without being forced into accounting mechanics.

Examples:
- purchases and sales;
- payments and collections;
- invoice/payment evidence upload;
- government expenses;
- owner-paid/company-related expenses;
- custody advances/settlements;
- banks, obligations, customers, suppliers and assets;
- close status and administrative financial visibility.

Do not force the manager to select debit/credit accounts or make unexplained accounting/tax judgments. Ask factual operational questions; accounting treatment follows policy, automation and authorized review.

## Phase 11 — Home Screen Alerts

The home screen is the attention center for the current version; do not build a separate complex task-management system now.

Show, subject to permissions:
- what requires action now;
- upcoming due items;
- close blockers;
- waiting for accountant;
- waiting for another team/user.

Clicking an alert navigates directly to its responsible module/record where possible.

If the current user can act, classify it as their required action. If they can view but cannot act, show it as waiting for accountant/team. Do not expose restricted details. Group repeated similar issues rather than flooding the home screen.

## Phase 12 — Manager Financial Snapshot

Only show values derived from trustworthy existing data:
- bank balances;
- amounts to collect;
- amounts to pay;
- current-month sales;
- current-month purchases/expenses.

Do not confuse bank balance with profit, liquidity or net financial position. Do not present net profit, margin, EBITDA or free cash flow as final until revenue, expenses, accruals, depreciation, inventory if applicable, adjustments and close are complete.

## Phase 13 — Conditional Modules

Implement only when a company genuinely needs them:
- inventory / COGS / stock counts and adjustments;
- e-invoicing / ZATCA Fatoora;
- advanced external integrations;
- paid OCR/AI/messaging services.

Before any conditional capability that may add cost, document the need, expected server/storage/API/subscription impact and obtain explicit approval.

## Phase 14 — Full Operational and Accounting Cycle Validation

Validate a real end-to-end cycle rather than isolated screens:

Company setup → Accounting & Tax Profile → Fiscal year → Opening balances → customers/suppliers → purchase → invoice/evidence → payment → sale → collection → expense → obligations → custody → banking/import/matching → fixed asset → depreciation → accruals/prepayments → VAT → journals/adjustments → ledger/trial balance → monthly close → financial statements → applicable Zakat/tax workpapers → year-end close.

Also validate tenant isolation, permissions, audit, duplicate prevention, period locks, numerical correctness, document relationships, tax handling, workflow state transitions and usability for a non-accountant manager.

A capability is not finally complete until it works coherently inside the full cycle.

## Phase 15 — System-wide UI/UX Redesign & Polish

Start only after functional/accounting completion and full-cycle validation.

Then redesign/polish the entire system across desktop/mobile, Arabic RTL/English LTR, all roles/modules, navigation, density, forms, tables, cards, loading/error/empty states, accessibility, identity and end-to-end user journeys.

Until then, UI/UX work is limited to functional blockers or defects that prevent correct use.

## Cost-control rule

The accounting/profile/policy/permission/alert logic should use the existing PostgreSQL/application infrastructure and should not itself require new recurring cost. The most likely future cost drivers are large document storage volumes and optional external integrations/services. These must be evaluated separately before adoption.

## Current execution order

1. Finish and merge the documentation task containing this roadmap and the Saudi compliance roadmap.
2. Before any programming begins, permanently fix/prove the Codex ↔ GitHub repository delivery path using the preflight above.
3. Only after that gate passes, begin Phase 1 — Company Accounting & Tax Profile.
4. E-invoicing/Fatoora is explicitly deferred and is not part of Phase 1.
5. Proceed sequentially through the roadmap, one accepted/merged phase at a time.
