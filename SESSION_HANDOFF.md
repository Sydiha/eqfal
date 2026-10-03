# EQFAL Session Handoff

**Date:** 2026-10-03
**Session:** PR backlog cleanup + state reconciliation

## Current Objective
Maintain synchronized EQFAL project context with minimal token/credit usage

## Current Task
idle

## Completed This Session
- PR #307 merged (Phase 15D Purchases visual)
- PR #214 merged (Codex trigger verification playbook), now referenced from AGENTS.md §15
- PR #229 closed without merge (superseded by #231)
- Open PRs: none
- Last reconciled main: `b04ef363eced64a2351016584ef75b44401212d3`

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
- Do not reopen completed PR #214, #229, #307, #314, #315, #316, #317, or #318 work.
- Do not reconsider GitHub Actions unless the Owner explicitly asks.

**Last updated:** 2026-10-03
