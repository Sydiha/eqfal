---
name: eqfal-handoff
description: Produce a concise factual handoff after an EQFAL task completes, stops, or requires an Owner decision.
---

# EQFAL Handoff

## Purpose
Preserve the exact project continuation point with a short factual report.

## When to use
Use after:
- successful task completion
- branch push
- validation failure that cannot be resolved within scope
- an Owner Gate
- a request to continue in a new session

## Before handoff
1. Update `PROJECT_STATE.md` if project/task state changed.
2. Update `SESSION_HANDOFF.md` with:
   - current objective
   - completed work
   - current decision
   - open item
   - next exact step
   - do-not-repeat items
3. Keep both files within their size limits.

## Output
Return only:

```text
Status:
Baseline:
Branch:
Commit SHA:
Files changed:
Tests:
CI:
Risks:
Owner action:
Next exact step:
```

## Rules
- Facts only.
- No long narrative.
- Do not repeat full project history.
- Clearly distinguish READY, BLOCKED, and NEEDS OWNER DECISION.
- Do not claim CI passed unless it was actually observed.
- Do not merge or deploy as part of handoff.
