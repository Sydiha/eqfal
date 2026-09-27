# TEMPORARY CODEX HANDOFF — DELETE BEFORE FINAL COMMIT

Authoritative Figma inspection was completed externally because Codex Cloud cannot access Figma MCP. Do not require Figma access as a preflight for this run.

## Home visual blueprint (Figma Review / الرئيسية / النظرة المالية)

The approved Home is a dense Arabic RTL financial workspace, not the old launcher/dashboard enlarged.

Desktop composition:
- White topbar across the content area, dark navy right sidebar.
- Sidebar is fixed on the right, approximately 16% of desktop width in the reference; logo/lockup at top; teal filled active Home row; compact vertical navigation rows beneath.
- Main workspace background is very light gray (#f5f7f9 family), with a wide white financial workspace using most of the available viewport.
- Topbar controls are compact: user/account, company switcher, period selector, search, EN; no duplicate full brand lockup in topbar.
- Main Home heading at top-right: `نظرة عامة مالية`, followed by current date and a short greeting/subtitle.
- Directly below is a horizontal financial KPI strip titled around consolidated financial snapshot. Four prominent KPI blocks appear in one row: bank/cash balance, receivables, payables, and current-month expenses/purchases. Values are visually dominant; labels secondary; teal/navy accents only.
- Middle section is the dominant operational area: a full-width table titled `قائمة المهام التي تتطلب متابعة`. It has filter control(s), multiple rows, compact status pills, owner/responsible column, amount/count columns, and action affordances. This table occupies substantially more visual area than the KPI strip.
- Bottom section is monthly-close readiness: a wide card/table on the left/center plus a circular readiness/progress visualization on the right. Reference shows a 60% circular indicator and a list of closing requirements/statuses with dates/owners.
- Cards have thin #e5ebf0-like borders, small radii (roughly 8–12px), almost no shadow, white surfaces. Avoid oversized rounded SaaS cards.
- Typography is Tajawal; navy headings; compact but readable financial density. Desktop hierarchy is heading > KPI values > table title/rows > supporting labels.
- Do not retain the current Home's large `daily operations` launcher as the dominant first card. If existing operations must remain for functionality, integrate them as compact secondary actions without displacing the approved financial hierarchy.
- Do not show the current old sequence of giant launcher card -> giant snapshot card -> alerts -> monthly-close card as the primary composition.
- RTL must be native: right sidebar, right-aligned Arabic content, correct table ordering.

## Shell identity
- Navy #0B1D33 family, teal #00B894 family, restrained sand-gold accent #D4AF37 family.
- White/light-gray financial surfaces; no gradients as a defining visual motif.
- Preserve existing EQFAL logo source; do not redraw it.

## Scope and safety
- Same PR #296 only.
- No API, DB, accounting logic, permissions, workflow semantics, or data-contract changes.
- Preserve all existing functional navigation and data wiring.
- No binary screenshots committed.
- Delete this `.codex-handoff/README.md` before the final implementation commit so it does not remain in the PR diff.

## Required validation
- typecheck
- existing Phase 15A shell test
- production build
- Arabic RTL desktop 1920x1080 running-build screenshot for reviewer comparison (artifact only, not Git)
- report changed files and commit SHA; no merge.
