> **STATUS: SUPERSEDED — HISTORICAL ONLY**
>
> This document records a previous operating model.
> It is not an active execution instruction.
> Current workflow authority is defined by `AGENTS.md` and `docs/WORKFLOW_GOVERNANCE.md`.

# Agent Readiness 2 — Supported Unattended Durable Delivery Decision

Status: **BLOCKED / NOT READY — UNATTENDED DURABLE DELIVERY CAPABILITY GAP**

Decision date: 2026-09-11

Related evidence: Issues #179, #180, PR #181, Issue #182.

## Objective

Determine whether a currently supported and actually proven mechanism can provide:

`Cloud Codex Builder → unattended durable GitHub branch + commit + PR`

without routine user intervention, Local delivery as the normal path, PAT/GH_TOKEN/manual credentials, OpenAI API key, new paid service/cost/infrastructure, Replit Git delivery, or Production changes.

## Proven results

- #179 — Builder execution: **PASS**; durable delivery: **NOT PROVEN**.
- #180 — Native Create PR from originating Cloud Codex session: **NOT PROVEN**.
- #181 — PR-first durable Builder handoff: **FAIL / NOT PROVEN**. GitHub durable envelope existed, but Cloud Codex did not prove unattended durable push of a new commit to the same PR branch.

## Supported mechanisms checked

### Cloud Codex native session delivery / Create PR
Supported as a product workflow, but not proven durable/reliable for this repository under the tested constraints. Repeating the same pattern is prohibited until materially new supported capability exists.

### Existing PR + @codex handoff
Supported for launching Cloud Codex from GitHub PR context. In #181, the pre-existing branch and PR were durable, but Cloud Codex did not prove unattended durable push to that branch. This therefore does not satisfy the delivery requirement.

### ChatGPT GitHub app / Work GitHub triggers
Supported for repository access and event-triggered workflows, but not established as a general unattended Cloud Builder code-write transport that creates the required branch + commit + PR from Cloud Codex output.

### Codex GitHub Action / API-based automation
Potentially automatable, but depends on credentials/secrets/API configuration and may introduce API usage/cost. Under current governance this falls behind `HUMAN DECISION REQUIRED` and is not eligible for automatic adoption.

### Local Codex / local Git transport
Can be used as exceptional recovery where already authorized, but recurring device/local involvement is not allowed as the normal operating model. It does not satisfy unattended-by-default execution.

### Codex Security remediation workflow
Not a general-purpose Builder delivery mechanism for EQFAL Product tasks and does not satisfy the target unattended Builder lifecycle.

## Formal decision

There is currently **no supported mechanism proven to satisfy all EQFAL unattended durable-delivery constraints**.

Accordingly:

1. Cloud Codex remains the **primary Builder execution engine**.
2. Agent Readiness 2 is **not complete**.
3. The unresolved blocker is **unattended durable GitHub delivery** from Cloud Builder output.
4. Do not repeat #179/#180/#181 delivery semantics as additional PoCs.
5. Do not make recurring Tooling Assistance part of the normal path.
6. Do not add PAT, GH_TOKEN, OpenAI API keys, secrets, paid capacity, runners, services, or infrastructure without the applicable Human Gate.
7. Orchestrator may resume only from independently readable durable GitHub evidence.
8. Local delivery remains exceptional fallback only, never the default architecture.
9. The default operating objective remains unattended execution; user involvement stays limited to `USER VALIDATION REQUIRED` and established `HUMAN DECISION REQUIRED` gates.
10. Phase 5 does not start while Agent-readiness remains blocked under the currently approved dependency sequence.

## Recheck trigger

Reopen this architecture decision only when a materially new supported capability becomes available that plausibly changes the result, such as a documented unattended Codex→GitHub write/delivery path that does not require prohibited credentials, new paid cost, Production changes, or recurring user action.

Until that point, the capability gap is considered formally established rather than an invitation to repeat the same delivery experiments.
