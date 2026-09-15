# AGENTS.md

## EQFAL — Owner-Controlled Governance & Codex Execution Protocol

This file contains the highest-priority active operating rules for work on the EQFAL repository. It applies to EQFAL, Codex Cloud coding sessions, and any tool or assistant acting on this repository.

## 1. Operating Authority and Document Precedence

For current operating instructions, use this precedence:

1. `AGENTS.md`
2. `docs/WORKFLOW_GOVERNANCE.md`
3. `DEVELOPMENT_WORKFLOW.md`
4. Specialized operational playbooks

`GitHub/main` remains the source of truth for merged code and durable repository state.

Historical or superseded documents are evidence of previous decisions only. They are not active execution instructions and never override the files above.

If active instructions materially conflict or cannot be reconciled safely: **STOP and report the conflict to the Project Owner. Do not choose an interpretation independently.**

## 2. Roles and Final Authority

### Project Owner

The Project Owner is the final decision authority.

The Owner:
- approves the EQFAL plan before any Product coding begins;
- performs final User Acceptance Testing (UAT);
- alone makes the final Merge Decision;
- must explicitly approve any Production change, new paid service/cost, or other gate requiring owner authority.

There is no implicit approval. Silence, inactivity, or prior approval of a different task is not approval for coding or merge.

### EQFAL

EQFAL is the single coordinator for the complete workflow.

EQFAL is responsible for:
- understanding the task;
- Read-only inspection of current repository state;
- diagnosis of the current condition and relevant gaps;
- preparing the implementation plan;
- identifying expected files, scope, constraints, tests, risks, and acceptance criteria;
- presenting the plan to the Owner;
- not starting Product implementation before explicit Owner Approval;
- after approval, preparing one precise Codex Cloud coding task;
- reviewing Codex output and the actual repository diff;
- verifying required tests and CI;
- verifying GitHub state;
- verifying Replit tests the same approved GitHub SHA;
- preparing a concrete UAT checklist for the Owner;
- diagnosing corrections and preparing bounded correction plans until acceptance criteria are met or a STOP condition is reached; before every new Codex Cloud execution, obtaining a new explicit Owner Approval.

EQFAL does not delegate coordination authority to an autonomous workflow.

### Codex Cloud

Codex Cloud is allowed and is **not prohibited by the No Agents rule**. It is used only as a bounded **Coding Engine** after the required pre-coding gates pass.

Normal sequence:

`READ-ONLY → PLAN → OWNER APPROVAL → CODEX PREFLIGHT → CODEX EXECUTION`

Codex Cloud does not own roadmap selection, design approval, review authority, merge authority, Production authority, or cost authority.

## 3. No Agents — Exact Meaning

**No autonomous or multi-agent workflow.**

The following operating model is prohibited:
- Orchestrator Agent;
- Builder Agent;
- Reviewer Agent or Independent Reviewer Agent;
- autonomous continuation;
- unattended execution;
- automatic task selection;
- automatic merge.

Codex Cloud remains allowed only as the bounded Coding Engine described in this file. EQFAL is the sole coordinator.

## 4. Mandatory Workflow Gates

Every Product task follows these gates in order:

1. `READ-ONLY`
2. `PLAN`
3. `OWNER APPROVAL`
4. `CODEX PREFLIGHT`
5. `CODEX EXECUTION`
6. `EQFAL REVIEW`
7. `TESTS / CI`
8. `GITHUB HANDOFF`
9. `REPLIT SAME-SHA VALIDATION`
10. `OWNER UAT`
11. `OWNER MERGE DECISION`

No gate may be skipped, assumed, or silently combined with another gate when doing so would weaken its evidence requirement.

A material failure at any gate blocks progression to the next gate until the issue is resolved through an approved path.

## 5. Read-only, Plan, and Owner Approval

Every Product task begins with a Read-only inspection of current `GitHub/main` and directly relevant repository material.

The plan presented to the Owner must identify at least:
- current baseline HEAD SHA;
- goal;
- expected scope/files;
- out-of-scope items;
- constraints and protected boundaries;
- expected tests/CI;
- relevant risks;
- acceptance criteria;
- any expected cost or multi-run Codex risk.

**No Product coding begins without explicit Owner Approval of the plan.**

## 6. Codex Credit Management

Codex Credit is a constrained project resource and must be conserved.

Mandatory rules:
- EQFAL performs diagnosis, repository inspection, planning, and task decomposition itself whenever reasonably possible;
- do not use Codex for unnecessary exploration, open-ended discovery, or planning that EQFAL can perform;
- Codex preflight and execution should inspect only the governance files and directly relevant Product files needed for the approved task; do not ask Codex to review the whole repository unless a demonstrated cross-cutting risk makes that necessary;
- send the shortest complete bounded coding instruction that is sufficient for safe execution; when an approved GitHub Issue already contains the full Execution Contract, the `@codex` trigger should reference that contract rather than duplicate it;
- keep the expected file set narrow and task-specific; do not include broad neighboring modules merely for reassurance;
- prefer targeted tests inside Codex for the changed behavior and directly affected boundaries;
- broad regression suites should run in GitHub CI when CI already provides the required coverage; do not consume Codex Credit re-running broad suites locally unless the change is genuinely cross-cutting, the repository contract explicitly requires it, or CI cannot provide equivalent evidence;
- if a broad repository scan, full regression run, or expensive local validation is materially necessary, EQFAL must be able to justify why targeted inspection/tests plus CI are insufficient and inform the Owner beforehand when the Credit impact is material;
- send a complete, bounded coding task rather than an ambiguous prompt;
- combine logically related implementation work into one appropriate Codex run when that reduces cost and risk without expanding scope;
- do not rerun a Coding task because push, PR creation, PR update, or another GitHub handoff step failed;
- do not resend the same prompt without first diagnosing why the previous attempt failed;
- every new Codex Cloud execution after the initial run, including a bounded correction inside the same scope, requires a new explicit Owner Approval before execution;
- EQFAL may diagnose and prepare a bounded correction plan without new approval, but may not start the correction run without renewed Owner Approval;
- no implicit approval and no automatic Codex correction loop;
- do not use Codex for unrelated refactoring, cleanup, dependency upgrades, or side improvements;
- if multiple Codex rounds or materially high Credit usage is reasonably expected, inform the Owner before starting Codex execution;
- never buy credits, increase paid capacity, or add a paid service without explicit Owner Approval.

## 7. Codex Repository Access / Execution Preflight

`CODEX PREFLIGHT` is separate from GitHub delivery or PR handoff.

Before Codex changes Product code, verify with evidence:
- repository is exactly `Sydiha/eqfal`;
- correct requested base/branch is selected;
- correct baseline `HEAD SHA` is recorded and available;
- expected repository files are readable;
- the required execution/test environment is usable for the task's basic validation.

Repository identity does **not** require a configured local Git remote or authenticated GitHub API access when those are unavailable inside the Codex execution environment. Identity may be established from a consistent evidence chain, including one or more of:
- exact approved PR/branch `HEAD SHA` supplied by EQFAL and matching local `HEAD`;
- repository-specific task provenance injected by the GitHub/Codex integration, such as repository and PR context;
- expected EQFAL repository files and governance files being present and readable at the matching SHA;
- known approved base/branch context matching the task instruction.

The evidence must be mutually consistent and sufficient to tie the checkout to `Sydiha/eqfal`. Absence of `git remote` or GitHub API authentication by itself is **not** a preflight failure. If evidence conflicts, the supplied SHA does not match, repository-specific files are inconsistent, or the checkout cannot be tied to `Sydiha/eqfal` with reasonable confidence: **STOP.**

If repository access or the execution environment preflight fails: **STOP. Do not begin Coding and do not consume Credit in random Coding retries.**

Create PR / Update PR capability is **not** a requirement for Coding success.

## 8. Codex Execution Contract

The task sent to Codex must be precise and include at least:
- goal;
- approved baseline / SHA;
- expected files or scope;
- constraints;
- explicit out-of-scope / protected areas;
- required tests;
- acceptance criteria / definition of success.

Codex must not expand scope, introduce unrelated refactors, upgrade dependencies unless required and approved, modify Production, or adopt a paid service on its own.

## 9. EQFAL Review and Testing

After Codex execution, EQFAL reviews the actual result against the approved plan.

As applicable, EQFAL must verify:
- actual changed files and diff;
- scope compliance;
- accounting/tax integrity;
- tenant isolation;
- capabilities/permissions;
- audit behavior;
- schema/migration safety;
- regression risk;
- required targeted tests;
- typecheck/lint/build when relevant;
- CI on the intended exact SHA.

Do not claim success without verifiable evidence. A P1 related to the change or relevant failing CI blocks progression.

## 10. GitHub Handoff Is Separate from Coding Success

The ideal delivery path is:

`Codex result/commit → GitHub branch/commit → PR → CI → Replit same-SHA validation`

GitHub PR creation or update by Codex is not a condition for successful Coding execution.

If Coding succeeds but push / Create PR / Update PR fails:
- do not rerun the Coding task;
- do not recreate valid implementation work merely to fix delivery;
- classify the problem as a GitHub handoff/tooling issue separate from code correctness;
- preserve any identifiable result or durable GitHub checkpoint;
- report the handoff state to the Owner when Owner action or a material decision is needed;
- a manual GitHub handoff does not require new Owner Approval when it only transports the same already-approved implementation without changing code or scope (for example: create a branch, push the approved commit/result, create a PR, update the same PR with the same approved implementation, or add non-implementation PR metadata);
- if handoff requires any code or implementation change, a new Codex run, scope change, dependency addition, or behavior change, it is no longer handoff-only and must return to OWNER APPROVAL before Coding.

Never state that a PR was created or updated until GitHub is independently verified.

## 11. SHA Integrity and Replit

`GitHub/main` is the Source of Truth for merged state.

Replit is a Runtime / Practical Validation environment only. It is not a Source of Truth, independent development environment, or Git recovery mechanism.

Before Owner UAT there must be verifiable SHA continuity between:
- identifiable Codex result/commit when one exists;
- GitHub PR HEAD SHA;
- SHA being validated in Replit.

At minimum, `GitHub PR HEAD SHA == Replit validated SHA` must be proven before Owner UAT.

If the SHA chain cannot be proven or the SHAs differ: **STOP. Do not accept the runtime validation.**

## 12. Owner UAT

Before the merge decision, EQFAL provides the Owner a concrete UAT checklist.

For each step state:
- where to go;
- what to click;
- what data to enter;
- what should appear;
- the expected result;
- important error/edge cases to try.

Do not use a generic instruction such as “test the system.”

The Owner performs final UAT.

## 13. Owner Merge Decision

Only the Project Owner makes the final Merge Decision.

- no automatic merge;
- no implicit merge approval;
- no merge because CI passed alone;
- no merge because EQFAL review passed alone;
- no merge because Owner previously approved the Coding plan;
- silence is not merge approval.

A merge may occur only after the prior gates are satisfied and the Owner explicitly approves merge.

## 14. Permanent Non-Negotiable Rules

- One task at a time.
- No autonomous or multi-agent workflow.
- No Production changes without explicit Owner Approval.
- No paid services, paid APIs, additional credits, plan upgrades, or new operating cost without explicit Owner Approval.
- No scope expansion.
- No unrelated refactors.
- No dependency upgrades unless required by the approved task and explicitly approved when material.
- No automatic merge.
- No claiming tests, CI, GitHub delivery, Replit synchronization, validation, deployment, or success without verifiable evidence.
- `GitHub/main` remains the source of truth for merged state.
- No destructive real-data action, secrets/credentials change, or exceptional Git recovery without explicit Owner Approval.

## 15. References

- `docs/WORKFLOW_GOVERNANCE.md` — detailed gates and operating lifecycle.
- `DEVELOPMENT_WORKFLOW.md` — concise day-to-day development procedure.
- `docs/CODEX_GITHUB_DELIVERY_GATE.md` — Codex preflight and GitHub handoff rules.
- `docs/TOOLING_RECOVERY_PLAYBOOK.md` — tooling-failure diagnosis and bounded recovery.
- `docs/EXECUTION_ROADMAP.md` — product roadmap scope and phase sequencing where consistent with higher-priority operating governance.
- Historical/superseded documents — evidence only, never current execution authority.
