---
name: eqfal-context-sync
description: Load the minimum current EQFAL project context before starting or continuing work.
---

# EQFAL Context Sync

## Purpose
Establish the current project state with minimal context and prevent stale-session decisions.

## When to use
Use this skill:
- at the start of a new Claude Code session
- before accepting a new task
- when continuing after a long pause
- when the Owner says to continue in a new conversation/session

## Execution
1. Read `PROJECT_STATE.md`.
2. Read `SESSION_HANDOFF.md`.
3. Fetch remote refs if required.
4. Verify current `origin/main` HEAD against the SHA recorded in `PROJECT_STATE.md`.
5. If the recorded SHA is stale because known work was merged, reconcile the current state before starting new work.
6. Read only files directly required by the current task.
7. Do not read README, TODO, ROADMAP, DECISIONS, or other large project documents unless:
   - required information is missing,
   - a contradiction exists,
   - or the current task explicitly requires them.

## Output
Return only:

```text
Main:
Phase:
Current task:
Last completed:
CI:
Blockers:
Next exact step:
```

## Rules
- GitHub current state overrides conversation memory.
- Never recommend or execute a task before verifying it is still pending.
- Do not perform repository-wide scans without a task-specific reason.
- Keep output concise.
- This skill does not modify code, merge PRs, deploy, or make Owner decisions.
