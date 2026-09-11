# EQFAL Workflow Governance

This document defines the detailed autonomous execution lifecycle for EQFAL. It complements `AGENTS.md` and cannot weaken any higher-priority security, tenancy, accounting, tax, cost, or Human Gate rule.

## 1. Authority Hierarchy

`GitHub/main → AGENTS.md → docs/WORKFLOW_GOVERNANCE.md → docs/TOOLING_RECOVERY_PLAYBOOK.md → docs/EXECUTION_ROADMAP.md → TODO.md → Historical records`

If a conflict exists, the higher source governs. Material ambiguity that cannot be resolved from current authoritative state requires `HUMAN DECISION REQUIRED`.

## 2. Operating Roles

### EQFAL Project — Product Owner + Lead PM + Roadmap Authority

EQFAL Project decides **WHAT, WHY, WHEN** and does not write Product code.

It must:
- read current `GitHub/main` and roadmap state;
- reason over dependencies and select the next task automatically;
- perform the Read-only Design Check;
- internally approve designs that satisfy the Design Gate and have no Human Gate;
- issue the binding Execution Contract;
- determine meaningful-increment/Phase completion;
- determine Human Gates and User Validation timing.

### Orchestrator — Execution Lifecycle Manager

The Orchestrator owns execution flow, not product scope.

It must:
- verify baseline and preflight readiness;
- route the approved contract to Builder;
- track durable GitHub checkpoints;
- classify failures and apply the recovery playbook;
- route the PR/diff to the Independent Reviewer;
- monitor required CI;
- evaluate the Automatic Merge Gate;
- merge only when every merge condition passes;
- record the new `main` SHA;
- coordinate post-merge runtime/practical validation;
- return evidence and state to EQFAL Project.

It must not alter roadmap/scope/contract, bypass Reviewer or CI, bypass a Human Gate, or invent accounting/tax/security/permission policy.

### Builder Role — Cloud Codex Primary

Builder is a governance role. **Cloud Codex is the primary execution engine.**

Builder performs:
- verified clean checkout;
- exact approved baseline;
- independent branch;
- implementation;
- approved migrations only when the contract includes them;
- required tests;
- commit, push, and PR.

Builder has no Design, Roadmap, Reviewer, Merge, Production, or Cost Authority and may not self-review or self-merge.

### Independent Reviewer

Reviewer is independent from Builder. It validates whether the implementation matches the approved Execution Contract and is safe; it does not redefine what should be built.

Reviewer inspects the actual GitHub diff and checks, where applicable:
- scope and contract compliance;
- accounting integrity;
- tax integrity;
- tenant isolation;
- permissions/capabilities;
- auditability;
- migrations/schema;
- regression risk;
- tests;
- required CI evidence tied to the exact SHA.

Allowed results only:
- `PASS`
- `FAIL`
- `NEEDS_CORRECTION`

Reviewer `PASS` alone is insufficient for merge. CI `PASS` alone is insufficient for merge.

### GitHub

GitHub is the durable delivery system of record. `main` is the only authoritative merged baseline. Branches, commits, PRs, diffs, review evidence, CI, merge state, and durable delivery history must be read from GitHub rather than reconstructed from session summaries.

### Replit

Replit is runtime/practical validation only. Current proven state and limitations are defined in section 14.

## 3. Standard Autonomous Task Lifecycle

For normal Product work after this governance model is merged:

`EQFAL Project task selection → Read-only Design Check → internal Design Approval if eligible → Execution Contract → Orchestrator preflight → Builder/Cloud Codex → tests → GitHub PR → Independent Reviewer → required CI → Automatic Merge Gate → merge → post-merge runtime/practical validation → EQFAL Project → user only when required`

Documentation-only governance work may use a healthy direct GitHub branch/commit/PR path when no Product code is involved.

## 4. Task Selection Rule

EQFAL Project selects the next task automatically from current `main`, the approved roadmap, and dependency order.

Routine next-task selection does not require user approval when:
- the task is already within the approved roadmap or a clear direct dependency;
- scope can be bounded from current authoritative sources;
- no Human Gate applies.

If a proposed task materially changes roadmap/product direction or remains materially ambiguous, issue `HUMAN DECISION REQUIRED`.

## 5. Mandatory Baseline / Preflight Gate

Before Builder changes Product code, Orchestrator verifies through actual evidence:
- repository `Sydiha/eqfal` is accessible;
- current `main` HEAD is read and recorded;
- applicable governance and roadmap sources are read from current `main`;
- the approved Execution Contract identifies the baseline SHA;
- Builder is attached to the intended repository/environment;
- Builder checkout is clean;
- Builder checkout HEAD exactly matches the approved baseline;
- no unresolved Human Gate blocks execution.

A UI saying “Connected” is not sufficient evidence.

Missing sandbox `origin`, sandbox `gh`, or a pre-implementation PR button is not itself a preflight failure if repository identity, checkout, baseline, and approved delivery path remain verifiable.

## 6. Design Gate and Internal Design Approval

Every Product task starts with a Read-only Design Check.

EQFAL Project may approve it internally only when all are true:
- task is inside the approved roadmap or a clear direct dependency;
- current `GitHub/main` has been read;
- goal, scope, out-of-scope, affected boundaries, risks, tests, and Definition of Done are explicit;
- no material ambiguity exists;
- no Human Gate applies;
- no Production change;
- no new paid cost;
- no destructive real-data action;
- no material new accounting/tax policy;
- no new sensitive security/permission policy outside the approved roadmap;
- tenancy, security, audit, capability, and architecture boundaries remain protected.

The approved Execution Contract must contain at least:
- baseline SHA;
- goal;
- scope;
- out-of-scope;
- affected boundaries;
- schema/migrations if applicable;
- acceptance criteria;
- required tests;
- Human Gates;
- Definition of Done.

Internal Design Approval never authorizes implementation self-approval. Independent Reviewer + required CI + Merge Gate remain mandatory.

## 7. Implementation Gate

After Design Approval:
- Builder receives one complete Execution Contract under the One-Shot Rule;
- Builder may implement only the approved scope against the approved baseline;
- migrations are allowed only if the contract explicitly includes them;
- required tests/validation must actually run;
- at most one corrective programming pass is allowed for a real implementation/acceptance blocker;
- tooling failures do not create extra corrective code passes;
- Builder cannot alter scope, roadmap, accounting/tax policy, Production, cost authority, or Human Gates.

## 8. Delivery Gate

Delivery passes only when:
- the implementation is durable on GitHub;
- an actual PR targets `main`;
- the intended branch/head SHA is known;
- the PR can be independently reviewed.

Routine delivery/recovery must not use:
- manual Copy Patch relay;
- `git apply` reconstruction between tools;
- Replit to recreate or move Builder work;
- routine force-push/history rewrite;
- user-mediated shuttling of commits, patches, source files, or routine logs.

If Delivery Gate fails, classify and recover only through `docs/TOOLING_RECOVERY_PLAYBOOK.md`.

## 9. Independent Review Gate

Reviewer must inspect the actual GitHub diff and issue one of `PASS`, `FAIL`, `NEEDS_CORRECTION`.

A `PASS` requires applicable checks of:
- exact approved scope/files;
- Execution Contract compliance;
- accounting/tax integrity;
- tenant isolation;
- capability/permission enforcement;
- auditability;
- schema/migration safety;
- regression risk;
- required test evidence;
- no prohibited Production/cost/destructive/security expansion.

`NEEDS_CORRECTION` may route to the single allowed corrective programming pass. A second corrective programming pass is prohibited by the Zero-Loop Rule and requires STOP/re-design.

## 10. CI Gate

Required GitHub CI/test evidence must be tied to the exact intended PR head SHA.

- `CI_CODE_FAILURE` = PROJECT FAILURE and may use the single corrective programming pass.
- `CI_INFRA_FAILURE` = TOOLING FAILURE and follows the recovery playbook.
- Green CI cannot override a Reviewer failure, scope violation, security defect, accounting/tax defect, or Human Gate.

## 11. Automatic Merge Gate

Orchestrator may merge without routine user approval only when all are true:

1. Actual GitHub PR targets `main`.
2. Correct approved task/baseline lineage is established.
3. Scope matches the Execution Contract.
4. No unapproved expansion exists.
5. Independent Reviewer = `PASS`.
6. Required CI = `PASS` on the exact intended PR head SHA.
7. No unresolved PROJECT blocker exists.
8. No unresolved TOOLING blocker affecting correctness/delivery exists.
9. No Human Gate applies.
10. No Production change is included.
11. No new paid service/API/infrastructure/credits/plan is included.
12. No destructive real-data action is included.
13. No secrets/credentials action is included.
14. No sensitive real-user permission action requiring Human Gate is included.
15. No material accounting/tax policy ambiguity/change requiring Human Gate exists.
16. No exceptional Git recovery such as force/history rewrite is required.

If any condition is false: **NO MERGE**.

## 12. Human Gate Rule

Issue `HUMAN DECISION REQUIRED` only when one of these applies:
- Production deployment/change;
- new paid service/API/infrastructure/credits/plan;
- destructive action on real data;
- material accounting/tax policy change not previously approved;
- secrets/credentials;
- material requirement ambiguity not resolvable from current governance/roadmap/code;
- sensitive real-user access change: Administrator-level access, cross-company expansion, approve/post/reopen/user-administration privileges for real users, or credentials/secrets tied to real users;
- exceptional recovery such as force-push, history rewrite, or destructive Git recovery.

Developing permission-model features within the approved roadmap is normal Product work and is not itself a Human Gate.

Routine task selection, ordinary internal Design Approval, branch creation, implementation, PR creation, CI, independent review, and compliant merge do not need user approval.

## 13. User Communication Lifecycle

### `NO ACTION REQUIRED`
Use when the project can continue without user action.

### `SYNC ASSISTANCE REQUIRED`
Temporary Replit-only state when GitHub → Replit sync needs a small operational action from the user. This is not approval, acceptance, or Human Decision. After successful sync, automation continues. Retire this state when full autonomous Replit sync is proven.

### `HUMAN DECISION REQUIRED`
Use only for Human Gates. Include exact decision, why automation cannot decide, options, impact, and what is blocked.

### `USER VALIDATION REQUIRED`
Use after a Phase or meaningful testable increment when practical user validation is needed. State:
- what completed;
- where to enter;
- what to click;
- what to inspect;
- expected result;
- what evidence to send if it fails.

The user is not a routine Git/PR/CI/Codex/branch integration operator.

## 14. Replit Current Proven State and Limits

**Replit Sync PoC: PASS WITH HUMAN ACTION**.

Proven during PoC:
- GitHub/main synchronized successfully to Replit;
- verified SHA: `2644c9fde0062221240409d47795ae2ee0d022e3`;
- Preview startup: `PASS`.

Not yet proven:
- full autonomous GitHub → Replit sync;
- runtime SHA verification from the running application.

Replit remains runtime/practical validation only.

Allowed in FREE MODE:
- GitHub `main` → Replit sync;
- Git state checks;
- application startup;
- Preview/basic smoke/runtime validation;
- runtime SHA verification once technically proven.

Prohibited:
- Product coding/source modification/refactoring/feature implementation;
- accounting/tax logic changes;
- DB/schema design or migrations;
- branch reconstruction, PR rescue, patch relay, or alternate Git delivery;
- push/write/PR changes to GitHub;
- Power Mode;
- Max Mode;
- paid credits/additional paid usage.

If Free Mode ceases to be actually free or an operation leaves the allowlist, STOP and use the applicable Human Gate.

## 15. Tooling Failure Classification and Recovery

Core principle:

**GitHub = durable project state. Codex session = disposable executor.**

Incidents are first classified as:
- **PROJECT FAILURE** — code/design/test/security/tenancy/accounting/tax/acceptance defect;
- **TOOLING FAILURE** — auth, repository connection, session, checkout, push/PR, CI infrastructure, tool availability, or credit/capacity problem while Product code is not established as defective.

Normal Builder recovery:

`Cloud Codex → one bounded tooling retry → fresh Cloud Codex session from verified GitHub state → approved Local Codex/fallback when applicable → STOP or Human Gate only when required`

No infinite loops, automatic paid credits, session-local claims of durability, routine history rewrites, or Replit Git recovery.

## 16. Failure-Stop Rules

STOP when:
- repository identity or approved baseline cannot be verified;
- a required GitHub review/delivery operation has no compliant verified path;
- continuing would violate an approved Execution Contract;
- Reviewer is `FAIL` and correction is not available within the Zero-Loop Rule;
- a second corrective programming pass would be required;
- cost, Production, destructive-data, secrets, real-user permission, accounting/tax policy, or exceptional-recovery Human Gate applies;
- material authority/requirement ambiguity remains unresolved.

## 17. Post-Merge Closeout

After a compliant merge, Orchestrator must:
- confirm the PR merged;
- read and record new GitHub/main HEAD;
- verify merged diff matches approved scope;
- confirm no unexpected files;
- record verified review and CI/test results;
- confirm no Human Gate was bypassed;
- confirm Production/cost/destructive/security boundaries were not changed without authorization;
- coordinate Replit/runtime validation as allowed;
- return evidence/state to EQFAL Project.

EQFAL Project then determines whether the increment is complete, whether the next roadmap task can start automatically, or whether `USER VALIDATION REQUIRED` / `HUMAN DECISION REQUIRED` applies.
