# EQFAL Session Handoff

**Date:** 2026-10-03
**Session:** State reconciliation + Arabic workflow rules

## Current Objective
Maintain synchronized EQFAL project context with minimal token/credit usage

## Current Task
idle

## Completed This Session
- Persistent-context workflow (PROJECT_STATE.md, SESSION_HANDOFF.md, three project skills) merged through PR #317
- Verified main at `f5b305a2abf3f3e73842962d3230cc2faf134a39`
- Reconciled project state to PR #317
- Approved automatic recovery for failures caused by the current task and contained within approved scope

## Current Decisions
- GitHub repository state is authoritative over conversation memory.
- PROJECT_STATE.md stores current project state only.
- SESSION_HANDOFF.md stores only the latest continuation point.
- Project skills live under `.claude/skills/<skill>/SKILL.md`.
- Default output language is Arabic, unless the Owner explicitly requests another language.
- No GitHub Actions, paid APIs, new services, Replit work, auto-merge, Production or Staging changes.
- Owner approval remains required for merge, architecture, database/schema, cost, production, destructive or governance decisions.

## Operational Fallback
If project skills are unavailable because the session starts outside the repository root, perform context-sync manually by reading PROJECT_STATE.md + SESSION_HANDOFF.md and verifying origin/main.

## Next Exact Step
Owner selects the next EQFAL task

## Do Not Repeat
- Do not redesign this workflow.
- Do not reopen completed PR #314, #315, #316, or #317 work.
- Do not reconsider GitHub Actions unless the Owner explicitly asks.

**Last updated:** 2026-10-03
