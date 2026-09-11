# EQFAL — Tooling Recovery Playbook

## 1. Purpose and Authority

This file is the canonical source for tooling-failure classification and recovery in EQFAL.

Authority hierarchy:

`GitHub/main → AGENTS.md → docs/WORKFLOW_GOVERNANCE.md → docs/TOOLING_RECOVERY_PLAYBOOK.md → docs/EXECUTION_ROADMAP.md → TODO.md → Historical records`

If this playbook conflicts with a higher source, the higher source governs. Material unresolved ambiguity uses the applicable Human Gate.

## 2. Core Principle

**GitHub = durable project state. Codex session = disposable executor.**

The Orchestrator owns recovery routing. A failed Cloud Codex session is not a failed project. Recovery starts by reading durable GitHub state and preserving the approved Execution Contract.

## 3. Recovery Roles

### Orchestrator
- classifies the incident;
- identifies the latest durable checkpoint;
- enforces the bounded retry policy;
- routes Builder to a fresh execution session or approved fallback;
- prevents scope/contract changes during recovery;
- stops at Human Gates or when no compliant path remains.

### Builder
Builder may retry execution only through the Orchestrator-approved recovery path. Builder may not invent a fallback, rewrite scope, self-merge, or use Replit for Git delivery/recovery.

### EQFAL Project
EQFAL Project is consulted if recovery reveals a Product/design ambiguity or requires a new Design Check. It does not convert a tooling failure into scope expansion.

## 4. Failure Classification

### PROJECT FAILURE
A defect in code, approved Design/Execution Contract compliance, tests, security, tenancy, accounting/tax integrity, schema, application behavior, or another acceptance requirement.

Examples:
- CI fails because code/test/build is wrong;
- implementation violates the approved contract;
- tenant isolation or permission enforcement is wrong;
- accounting/tax behavior is incorrect.

PROJECT FAILURE may use the single corrective implementation pass allowed by the Zero-Loop Rule. A second corrective programming pass requires STOP and re-design/re-evaluation.

### TOOLING FAILURE
A failure in execution/delivery infrastructure or session state while Product code has not been established as defective.

Examples:
- auth/connector failure;
- stale/missing checkout;
- Cloud Codex session failure;
- push/PR creation failure;
- CI infrastructure failure;
- tool availability or credit/capacity issue.

TOOLING FAILURE never consumes extra code-fix passes.

## 5. Durable Checkpoints vs Session-Local State

### DURABLE CHECKPOINT
State independently readable from GitHub, including:
- merged `main` commit;
- pushed branch/commit;
- open PR;
- GitHub CI/review evidence tied to a known SHA.

Durable state is reused directly. Never rebuild it merely because an execution session failed.

### SESSION-LOCAL / NON-DURABLE STATE
Examples:
- uncommitted workspace changes;
- local-only unpushed commit;
- terminal output existing only in a session;
- Codex conversation/session state.

Never claim session-local state is preserved after session failure unless it has reached a durable GitHub checkpoint.

## 6. Global Recovery Rule

Normal Builder recovery path:

`Cloud Codex attempt → classify → one bounded tooling retry → fresh Cloud Codex session from verified GitHub state → approved Local Codex/fallback when applicable → STOP or Human Gate only when required`

Mandatory constraints:
- one tooling retry maximum before moving to a fresh session;
- no repeated reconnect/auth/push loops;
- no automatic purchase/consumption of additional paid credits;
- no automatic paid-mode/service upgrade;
- no rebuilding valid pushed commits/branches/PRs;
- no Replit PR rescue, branch reconstruction, patch relay, or GitHub writes;
- no routine force-push/history rewrite;
- no assumption that session-local state survived;
- no recovery-driven change to roadmap, scope, accounting/tax/security policy, or the approved Execution Contract.

## 7. Recovery Baseline Procedure

Before a fresh Builder execution session:
1. Orchestrator reads current GitHub `main` HEAD directly.
2. Identify the approved task baseline and Execution Contract.
3. Search GitHub for durable task checkpoints.
4. If a valid PR/pushed commit exists, continue from that durable state rather than reimplementing.
5. If no durable work exists, start only from the verified approved baseline/contract.
6. If `main` changed materially relative to the approved contract, return to EQFAL Project for compatibility determination or a refreshed Design Check.
7. Never infer durable state from stale local workspaces, branch names, or conversation memory.

## 8. Incident Playbooks

### AUTH_FAILURE — TOOLING FAILURE
1. Confirm GitHub repository state independently when possible.
2. Retry the required auth/tool connection once.
3. If still failing, use a fresh Cloud Codex/session context from verified GitHub state.
4. Use approved fallback only if allowed and equivalent.
5. If the required path remains unavailable, STOP. If credentials/secrets or exceptional access action is required, issue `HUMAN DECISION REQUIRED`.

### REPO_CONNECTION_FAILURE — TOOLING FAILURE
1. Verify `Sydiha/eqfal` from the managing GitHub connection.
2. Retry repository attachment once.
3. If still failing, start a fresh Builder session attached to verified repository state.
4. If identity remains unverifiable, STOP before Product changes.

### BASELINE_MISMATCH — TOOLING / STATE FAILURE
1. STOP before Product changes.
2. Read current GitHub/main and approved task baseline.
3. Determine whether the approved contract remains compatible.
4. Use a clean/fresh checkout matching the approved baseline, or return to EQFAL Project if a refreshed Design Check is required.

Never silently continue on a stale or arbitrary baseline.

### DIRTY_WORKTREE — TOOLING / STATE FAILURE
1. STOP before editing.
2. Do not delete/reset unknown work automatically.
3. Determine whether dirty state is durable or session-local.
4. Prefer a fresh clean checkout from verified GitHub state.

### STALE_CHECKOUT — TOOLING FAILURE
1. Do not implement from it.
2. Retry safe verified refresh once.
3. Otherwise discard the disposable checkout/session and use a fresh one from verified GitHub state.

### CANNOT_RESUME_TASK / SESSION_FAILURE — TOOLING FAILURE
1. Inspect GitHub for durable checkpoints first.
2. Reuse any valid pushed branch/commit/PR.
3. Never assume uncommitted/local-only work survived.
4. If no durable checkpoint exists, start a fresh Cloud Codex session from the approved baseline/contract.
5. If normal Cloud Codex execution remains unavailable, use approved Local Codex/fallback when applicable.
6. If capacity/cost or another Human Gate is reached, STOP.

### PUSH_FAILURE — TOOLING FAILURE
1. Determine whether any task commit/branch is already durable on GitHub.
2. Retry the approved delivery mechanism once.
3. If still failing, use a fresh delivery session/context from existing durable state when possible.
4. If no durable checkpoint exists, do not claim implementation preservation.
5. Do not use Replit, manual patch relay, or routine force-push.

### PR_CREATION_FAILURE — TOOLING FAILURE
1. Preserve/reuse the pushed branch/commit.
2. Retry PR creation once through the approved GitHub/Builder path.
3. If still failing, use a fresh healthy GitHub delivery context against the same durable branch.
4. Never reimplement valid durable work.
5. STOP if no compliant path remains.

### CI_INFRA_FAILURE — TOOLING FAILURE
1. Confirm infrastructure failure from evidence tied to the intended SHA.
2. Re-run once.
3. If infrastructure fails again, STOP/defer until healthy.
4. Never modify Product code to compensate for an infrastructure outage.

### CI_CODE_FAILURE — PROJECT FAILURE
1. Compare failure against the approved Execution Contract.
2. Use the single allowed corrective programming pass when appropriate.
3. Re-run required validation/CI.
4. If a second corrective implementation pass is required, STOP and return to EQFAL Project.

### CODEX_CREDIT_LIMIT / PAID_CAPACITY_REQUIRED — TOOLING / COST FAILURE
1. STOP before purchase/upgrade.
2. Record the latest durable GitHub checkpoint.
3. Do not buy credits or switch to paid capacity automatically.
4. Use an already-approved no-new-cost fallback only when it is authorized and suitable.
5. Otherwise issue `HUMAN DECISION REQUIRED` for any new paid cost, or defer until approved capacity is available.

### REPLIT_SYNC_ASSISTANCE
This is not a Product failure and not a Human Decision by itself.

When the current GitHub → Replit sync still needs a small user action:
- issue `SYNC ASSISTANCE REQUIRED`;
- keep the request limited to synchronization/runtime assistance;
- do not treat it as approval or User Acceptance;
- after successful sync, continue runtime/practical validation.

Replit must not write to GitHub or rescue Builder delivery.

### EXCEPTIONAL_GIT_RECOVERY
Force-push, history rewrite, destructive Git recovery, or another non-routine repository operation is a Human Gate.

- STOP normal automation.
- Preserve all known durable state.
- Issue `HUMAN DECISION REQUIRED` with the exact recovery plan and risk.
- Do not execute until explicitly approved.

## 9. Valid Recovery Paths

Valid paths include:
- re-reading GitHub/main/current PR state;
- one bounded tooling retry;
- fresh Cloud Codex session from verified GitHub state;
- approved Local Codex/fallback when applicable without violating cost/governance;
- continuing from existing pushed branch/commit/PR;
- one CI infrastructure rerun;
- `SYNC ASSISTANCE REQUIRED` for the temporary Replit sync limitation;
- STOP/Human Gate when no compliant autonomous path exists.

## 10. Prohibited Recovery Paths

Do not use:
- Replit for Product coding, PR rescue, push, branch reconstruction, patch relay, or GitHub writes;
- Copy Patch/manual patch relay as routine delivery;
- `git apply` reconstruction between tools as routine recovery;
- routine force-push/history rewrite;
- repeated auth/push/session loops;
- automatic paid-credit purchase or plan upgrade;
- reimplementation of valid durable work because a session failed;
- session-local claims of durability;
- Builder self-review/self-merge;
- Reviewer or CI bypass;
- recovery as justification for Production, accounting/tax policy, security, or scope expansion.

## 11. Human Gates During Recovery

Use `HUMAN DECISION REQUIRED` when recovery requires:
- new paid capacity/service/API/infrastructure/plan;
- Production change;
- secrets/credentials action;
- destructive real-data action;
- sensitive real-user access change;
- material accounting/tax policy decision;
- material unresolved requirement ambiguity;
- force-push/history rewrite/destructive Git recovery or equivalent exceptional path.

Routine tooling recovery that stays inside approved paths does not require user approval.

## 12. Recovery Closeout Checklist

After successful recovery, Orchestrator must:
- identify the durable checkpoint used;
- verify repository and approved baseline/contract lineage;
- verify actual branch/PR/head SHA;
- verify review/CI evidence tied to the intended SHA when applicable;
- confirm no prohibited recovery path was used;
- confirm no automatic paid cost was introduced;
- confirm no valid durable work was unnecessarily rebuilt;
- return to the lifecycle in `docs/WORKFLOW_GOVERNANCE.md`.
