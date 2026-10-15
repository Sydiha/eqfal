# Invoice permission provisioning

**Superseded by migration 075 (owner decision 2026-10-15).** The explicit-grant-only exception of migration 063 is
removed: every capability, `invoice.*` included, is held by Full Access through the wildcard, and a database CHECK
(`capabilities_full_access_wildcard`) keeps `implicit_full_access = TRUE` for every current and future capability.
No manual SQL provisioning is needed any more.

## How invoice permissions are granted now
- **Full Access** members hold every invoice capability automatically.
- Any other role receives invoice capabilities through the normal Users & Permissions screen. The granter must hold
  the capability and `access.role.capability.grant` (the grant ceiling); a Full Access member or a System Admin can
  therefore grant any of them.
- **Approval** needs `invoice.approve` only (`invoice.adjust_approve` for credit/debit notes). `obligation.confirm`
  and `accounting.journal.create` are no longer prerequisites. Approval still runs the same atomic system effects:
  number, confirmed obligation, a balanced **DRAFT** journal that is never posted automatically, and the VAT review.
  Posting stays a separate step that needs `accounting.journal.post`. Manual journal capabilities are unchanged and
  do not come with `invoice.approve`. VAT, closed-period, fiscal-year, account-mapping and balance checks are unchanged,
  and self-approval follows migration 074.

## Rollback
Reverting the wildcard requires an Owner-approved forward migration (see the header of migration 075). Never edit
applied migrations and never run against Production or Staging without explicit Owner approval.
