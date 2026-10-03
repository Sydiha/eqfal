---
name: eqfal-task-executor
description: Execute one approved EQFAL task with minimal scope, minimal context, targeted validation, and automatic recovery within scope.
---

# EQFAL Task Executor

## Purpose
Execute one approved task end-to-end while minimizing context, unnecessary file reads, unnecessary tests, and Owner interruptions.

## Inputs
Require:
- Task
- Approved scope
- Success criteria
- Baseline SHA
- Owner Gates, if any

## Execution
1. Run the `eqfal-context-sync` procedure.
2. Verify the required baseline against current `origin/main`.
3. If the baseline differs unexpectedly, stop and report.
4. Create or use the approved task branch.
5. Read only files needed for the approved scope.
6. Make the smallest change that satisfies the task.
7. Run targeted tests first.
8. Run typecheck when relevant.
9. Run build or full test suite only when required by the task, affected surface, or CI gate.
10. If validation fails because of this task and the fix remains inside approved scope, diagnose, fix, and retest automatically.
11. If the required fix exceeds approved scope or crosses an Owner Gate, stop and report.
12. Update `PROJECT_STATE.md` only when project/task state changed.
13. Update `SESSION_HANDOFF.md` with the exact continuation point before stopping or handing off.
14. Commit and push normally when the task instructions authorize those actions.
15. Finish using the `eqfal-handoff` format.

## Automatic Recovery Allowed
Automatic fixes are allowed only when caused by the current task and contained within approved scope, including:
- test fixture corrections
- import/export corrections
- type errors caused by the task
- formatting or lint corrections
- variable renaming required by the task
- test expectation updates directly caused by the approved change

## Owner Gates
Stop and request Owner approval for:
- scope expansion
- architecture changes
- database or schema changes
- real-data destructive changes
- Production or Staging changes
- paid services or cost-impacting changes
- governance changes
- accounting or tax policy decisions
- force push or history rewrite
- merging to `main`

## Context Rules
- One task at a time.
- Do not refactor unrelated code.
- Do not inspect unrelated modules merely for background.
- Prefer targeted validation over full-suite validation unless the task or CI requires more.
- Do not generate long narrative reports.
