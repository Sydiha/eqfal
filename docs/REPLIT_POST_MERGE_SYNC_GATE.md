# EQFAL — Mandatory Post-Merge Replit Sync Gate

## Status

This is an active EQFAL operating rule approved by the Project Owner on 2026-09-16.

It supplements `AGENTS.md` and `docs/WORKFLOW_GOVERNANCE.md` and must be followed whenever a merged change affects the repository state used by Replit.

## Permanent Rule

Any merged **change, addition, fix, migration, or other repository modification** must be synchronized from `GitHub/main` to Replit **before the current phase/task is declared closed and before work starts on the next Product task**.

A phase/task is not operationally complete merely because its PR was merged or CI passed.

The required closeout chain is:

`OWNER MERGE DECISION → MERGE TO GITHUB/MAIN → REPLIT POST-MERGE SYNC → RUNTIME/HEALTH VERIFICATION → TASK/PHASE CLOSEOUT → NEXT TASK`

## Required Evidence

Before closing the task/phase, EQFAL must verify and report:

1. the current authoritative `GitHub/main` SHA after merge;
2. Replit local `main` SHA;
3. Replit `origin/main` SHA;
4. proof that the Replit local `main` and `origin/main` match the authoritative `GitHub/main` SHA;
5. clean/expected Git state with no unresolved divergence affecting the synchronized state;
6. basic runtime validation appropriate to the change, at minimum the frontend Preview and backend/API health when those services are expected to run.

If a migration or runtime-relevant change requires an additional safe validation step, perform that validation before closeout under the normal governance constraints.

## Failure Rule

If Replit cannot be synchronized to the merged `GitHub/main` SHA, or runtime verification fails:

- **do not close the phase/task**;
- **do not move to the next Product task**;
- diagnose the synchronization/runtime issue as a bounded tooling/validation problem;
- do not change Product scope merely to force synchronization;
- do not use Replit as the Source of Truth or as a substitute for GitHub history.

## Boundaries

- `GitHub/main` remains the Source of Truth.
- Replit remains Runtime / Practical Validation only.
- This rule does not authorize Production publishing.
- This rule does not authorize Replit Agent coding.
- This rule does not bypass Owner Approval, Codex, review, CI, UAT, or Merge Decision gates.
- Synchronization should transport the already merged authoritative state only; it must not introduce independent Product changes.

## Operational Note

The pre-merge Replit same-SHA validation defined in higher-priority governance remains valid where required. This document adds a **mandatory post-merge synchronization and runtime-verification closeout gate** so that Replit is always current before the project advances to the next task.
