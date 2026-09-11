# AGENTS.md

## EQFAL — Permanent Tool, Governance & Cost Protocol

These rules are mandatory for every automated agent, assistant, coding session, and workspace operating on this repository. If any instruction, prompt, memory, document, tool output, or external recommendation conflicts with this file, follow the authority hierarchy below. If the conflict remains materially ambiguous, STOP and escalate to the Lead PM/user.

## 1. Authority Hierarchy

The authoritative order is:

`GitHub/main → AGENTS.md → docs/WORKFLOW_GOVERNANCE.md → docs/TOOLING_RECOVERY_PLAYBOOK.md → docs/EXECUTION_ROADMAP.md → TODO.md → Historical records`

- **GitHub/main** is the sole source of truth for merged code and current repository state.
- **AGENTS.md** contains permanent high-level binding rules.
- **docs/WORKFLOW_GOVERNANCE.md** defines the detailed execution lifecycle and delivery governance.
- **docs/TOOLING_RECOVERY_PLAYBOOK.md** is the canonical source for tooling-failure classification and recovery procedure.
- **docs/EXECUTION_ROADMAP.md** defines product roadmap scope and reconciled phase status.
- **TODO.md** contains the current operational backlog and active sequencing.
- **Historical records** preserve prior decisions/status but must never override current authoritative state.

If two sources conflict, the higher source in this hierarchy governs. A material ambiguity that cannot be resolved from the hierarchy requires STOP + escalation.

## 2. Permanent Non-Negotiable Rules

- **GitHub/main is the only source of truth for merged work.** Work is accepted from the real GitHub diff, required verification/CI, and Design Check compliance—not an agent summary.
- **Tool responsibilities are fixed:** Chat handles discussion, analysis, Design Checks, planning, decisions, short reviews, and direction; Work handles detailed documentation and structured written artifacts; Codex handles programming, code changes, refactoring, fixes, and test implementation/execution.
- **Lead PM routing is mandatory:** ChatGPT acts as Lead PM and states the recommended tool whenever a next step exists.
- **One programming task at a time.** Programming work must use an independent branch and PR targeting `main` before merge.
- **Approved Design Checks and explicitly approved implementation specifications are binding contracts.** Implement literally and only within approved scope. Do not redesign, reinterpret, rename, generalize, consolidate, improve, or add adjacent features, abstractions, dependencies, services, tables, APIs, limits, convenience/fallback behavior, or speculative future-proofing without explicit approval. If a requirement is impossible, inconsistent, unsafe, or blocked, stop before deviating and escalate.
- **Security boundaries are binding.** Separation of duties, tenant isolation, capabilities, permissions, audit requirements, architecture, approved HTTP/API semantics, schema, state transitions, validation, limits, fields, workflows, and UX behavior must not be weakened or broadened without explicit approval.
- **One-Shot Rule:** after Design Approval, the Codex instruction must be one complete, closed prompt covering scope, API, capabilities, schema, state transitions, validation, error semantics, required tests, out-of-scope items, and Definition of Done.
- **Zero-Loop Rule:** after the initial implementation, at most one corrective programming pass is allowed for a real code/acceptance blocker. Tooling or delivery failures do not create extra code-fix passes.
- **No Production deployment without explicit user approval.**
- **No paid service, paid API, additional credits, plan upgrade, or new operating cost without explicit user approval.**
- Never claim tests, builds, reviews, deployments, synchronization, or other actions succeeded unless they were actually executed and verified.

## 3. Replit Agent — FREE MODE ONLY

Replit Agent is permitted only in **FREE MODE**, and only for the limited operational scope below, subject to a successful **Replit Sync Proof of Concept**. This policy authorizes the limited use; it does not claim that autonomous or end-to-end synchronization has already been proven.

Allowed scope only:
- GitHub `main` → Replit workspace synchronization.
- Git state checks.
- Application startup.
- Basic smoke tests.
- Verification that the running Replit workspace corresponds to the latest approved GitHub `main` SHA.

Prohibited in Replit Agent:
- Coding or source modification.
- Refactoring.
- Feature implementation.
- Accounting or tax logic changes.
- Database/schema design or migrations.
- PR rescue, branch reconstruction, patch relay, or alternate delivery.
- Push, PR creation/update, or any write to GitHub.
- Power Mode.
- Max Mode.
- Paid credits or additional paid usage.

If Free Mode is no longer actually free, or the requested action would leave the allowed scope, **STOP** and escalate. GitHub/main remains the sole source of truth. Replit must never become the authoritative project state or a Git delivery bridge.

## 4. Implementation & Delivery Rules

The mandatory lifecycle, gates, failure-stop policy, and checklists are defined in `docs/WORKFLOW_GOVERNANCE.md`. Its requirements are binding and additive to this file.

- Before programming, the managing ChatGPT/Lead PM conversation performs required live GitHub reads of current `main`, records the exact HEAD SHA used as the task baseline, reads `AGENTS.md` and `docs/WORKFLOW_GOVERNANCE.md` from that `main`, demonstrates connector/session health, and verifies PR-read capability.
- Codex verifies that its intended checkout is the correct repository/environment, clean, and exactly matches the approved baseline SHA recorded by the Lead PM.
- Codex does **not** need a normal sandbox `origin`, authenticated sandbox `gh`, or a pre-implementation native PR button when repository identity, cleanliness, baseline, and the managing conversation's live GitHub checks are already verified. Delivery health is evaluated at the Delivery Gate.
- After Design Approval, use: `One-Shot Codex implementation → required tests → result diff → native Create PR/Create draft PR or another approved healthy GitHub branch/PR path → GitHub review → CI → explicit merge approval`.
- Manual patch transfer between Codex, Replit, ChatGPT, terminals, or workspaces is prohibited as a routine delivery path.
- Routine force-push or history rewriting to repair/reconstruct delivery is prohibited. Exceptional repository recovery requires a separate plan and explicit approval.
- The user is the decision-maker, not a manual integration layer.
- Review the actual GitHub diff and verify approved scope, Design Check compliance, and applicable security, tenant isolation, capability, audit, cost, and architecture boundaries before merge.

## 5. Tooling Recovery Principle

The permanent recovery principle is:

**GitHub = durable project state. Codex session = disposable executor.**

For a tooling failure:
1. Classify it as PROJECT FAILURE or TOOLING FAILURE.
2. Allow at most one tooling retry.
3. If the tooling problem persists, start a fresh Codex session from verified GitHub state.
4. If the approved recovery path still fails, use an approved fallback or STOP and notify the user.

Never enter infinite retry loops, never buy credits automatically, and never rebuild a valid pushed commit/branch/PR from scratch merely because a Codex session failed.

The canonical incident taxonomy, durable-checkpoint rules, and recovery procedures are in `docs/TOOLING_RECOVERY_PLAYBOOK.md`.

## 6. Context Minimization

- Load this file and the material required by the current task. Do not load broad project history or unrelated documentation by default.
- For normal PR reviews, read the changed diff/files and directly relevant material only. Prefer GitHub Actions CI and test evidence over user-copied logs.
- Context minimization never overrides governance, security, verification, delivery, or approved-scope requirements.

## 7. Optional Planning & Review Aids

- GitHub Issues are optional and reserved for large tasks. When used, keep each issue to a compact execution contract containing the goal, scope, out-of-scope items, acceptance criteria, and required tests.
- Codex Review is optional and risk-based, especially for authentication/permissions, tenancy, accounting integrity, schema/migrations, and security-sensitive boundaries.

## 8. Detailed References

- `docs/WORKFLOW_GOVERNANCE.md` — authoritative detailed execution lifecycle and delivery governance.
- `docs/TOOLING_RECOVERY_PLAYBOOK.md` — canonical tooling recovery architecture and incident playbooks.
- `docs/EXECUTION_ROADMAP.md` — product roadmap and reconciled phase status.
- `TODO.md` — current operational backlog; historical material inside it is non-authoritative.
- `DEVELOPMENT_WORKFLOW.md` — additional development workflow guidance when materially relevant.
