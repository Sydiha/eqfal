> **STATUS: SUPERSEDED — HISTORICAL ONLY**
>
> This document records a previous operating model.
> It is not an active execution instruction.
> Current workflow authority is defined by `AGENTS.md` and `docs/WORKFLOW_GOVERNANCE.md`.

# Architecture Decision — Product Track and Agent Infrastructure Track Separation

Status: Approved
Date: 2026-09-11
Baseline decision context: GitHub/main at `c21509904291dbbbee0ac15223adebd2f52b3a4c`

## Decision

EQFAL now operates two independent work tracks:

1. **Product Track** — continues the approved Product roadmap from current dependencies, including Phase 5.
2. **Agent Infrastructure Track** — continues improving autonomous execution infrastructure, including the unresolved Automatic Continuation Gap.

The **Automatic Continuation Gap blocks Full Autonomous Readiness only**. It does **not** block the Product Track, Phase 5, or later Product work that is otherwise eligible under current governance.

## Evidence basis

End-to-end governed execution capability was practically demonstrated through PR #188 with the following completed path:

`Builder → Connector Publisher → durable PR → Independent Reviewer PASS → exact-SHA CI PASS → Merge Gate PASS → merge → Replit sync → runtime practical validation PASS → USER VALIDATION completed`

Durable delivery through Connector Publisher is therefore considered proven for the current execution model.

## Autonomy status

Full Autonomous Readiness remains **NOT READY** until event-driven automatic continuation is operationally proven. The unresolved Automatic Continuation Gap remains on the Agent Infrastructure Track and must not be represented as solved merely because Product work continues.

## Operating consequences

- Product tasks continue to require the normal Read-only Design Check, Execution Contract, Builder, durable GitHub delivery, Independent Reviewer, exact-SHA CI, Merge Gate, merge, and post-merge runtime validation.
- Product work does not wait for event-driven continuation proof.
- The Agent Infrastructure Track must not silently change Product scope or roadmap priority.
- No Production, paid-cost, secrets/credentials, destructive real-data, sensitive real-user permission, material accounting/tax policy, exceptional Git recovery, or unresolved material ambiguity Human Gate is weakened by this decision.
- Replit remains runtime/practical validation only and is not a Git rescue or Builder delivery mechanism.
- Replit Agent is prohibited in all circumstances; approved Replit interaction is manual **Replit Shell only**.
