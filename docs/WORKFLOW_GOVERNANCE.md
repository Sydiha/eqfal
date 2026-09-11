# EQFAL Workflow Governance

This document defines the detailed execution lifecycle for EQFAL tasks. It complements `AGENTS.md` and does not weaken any higher-priority repository, security, tenancy, cost, or approval rule.

## 1. Authority Hierarchy

`GitHub/main → AGENTS.md → docs/WORKFLOW_GOVERNANCE.md → docs/TOOLING_RECOVERY_PLAYBOOK.md → docs/EXECUTION_ROADMAP.md → TODO.md → Historical records`

- GitHub/main = sole merged code/source-of-truth state.
- AGENTS.md = permanent high-level binding rules.
- WORKFLOW_GOVERNANCE = detailed execution lifecycle.
- TOOLING_RECOVERY_PLAYBOOK = canonical tooling recovery detail.
- EXECUTION_ROADMAP = product roadmap/status.
- TODO = current operational backlog.
- Historical records must never override current authoritative state.

If a conflict exists, the higher source governs. A material ambiguity that remains unresolved requires STOP + escalation.

## 2. Roles of Chat / Codex / GitHub / Replit

### Chat
ChatGPT acts as Lead PM for task framing, Design Checks, scope control, decision-making, review, governance, and routing.

### Codex
Codex is the implementation tool for programming work after Design Approval. It must work against the approved repository/environment and deliver through the approved GitHub branch/PR path.

### GitHub
GitHub is the durable delivery system of record. `main` is the only authoritative merged baseline. Branches, commits, pull requests, diffs, reviews, CI, merge state, and delivery history must be verified from GitHub rather than reconstructed from summaries or local workspaces.

### Replit Agent — FREE MODE ONLY
Replit Agent is permitted only in **FREE MODE** and only for the approved operational allowlist below, subject to successful **Replit Sync Proof of Concept**. This permission does not claim that autonomous/end-to-end synchronization has already been proven.

Allowed only:
- GitHub `main` → Replit synchronization.
- Git state checks.
- Application startup.
- Basic smoke tests.
- Runtime/latest-approved-main SHA verification.

Prohibited:
- coding, source modification, refactoring, or feature implementation;
- accounting/tax logic changes;
- DB/schema design or migrations;
- PR rescue, branch reconstruction, patch relay, or alternate delivery;
- push/write/PR changes to GitHub;
- Power Mode;
- Max Mode;
- paid credits or additional paid usage.

If Free Mode is no longer actually free, or the task requires leaving the allowlist, STOP and escalate.

Replit remains non-authoritative. It is not a Git delivery bridge and may not be used to rescue Codex work. The Replit Sync PoC remains a separate Agent-readiness blocker until it succeeds in practice.

## 3. Standard Task Lifecycle

For a programming task:

`ChatGPT Design/Decision → Codex implementation → GitHub PR → GitHub Actions CI → GitHub diff review → explicit merge approval`

1. Define task goal and scope.
2. Perform Mandatory Delivery Preflight in the managing conversation and verified Codex checkout.
3. Perform Read-only Design Check.
4. Obtain explicit Design Approval.
5. Send one complete One-Shot Codex implementation contract.
6. Run required tests/validation.
7. Review result diff.
8. Pass Delivery Gate by creating an actual GitHub PR targeting the intended base.
9. Review real GitHub diff and approved Design Check compliance.
10. Verify CI.
11. Obtain explicit merge approval.
12. Merge.
13. Perform post-merge closeout and record new baseline.

Documentation-only governance tasks may use a healthy direct GitHub branch/commit/PR path when no product code is involved.

## 4. Mandatory Preflight Checklist

Before programming begins, the Lead PM must verify through actual GitHub operations:

- repository `Sydiha/eqfal` is accessible;
- `main` is accessible;
- current `main` HEAD SHA is read and recorded as the intended task baseline;
- `AGENTS.md` and this file are read from that baseline;
- GitHub connector/session health is demonstrated by successful reads;
- PR-read capability is available;
- the Codex task is attached to the intended repository/environment or verified checkout;
- the Codex checkout is clean;
- the Codex checkout HEAD exactly matches the approved baseline before implementation.

A connector merely displayed as “Connected” is insufficient.

PR delivery capability is evaluated later at the Delivery Gate. Missing sandbox `git remote`, sandbox `origin`, authenticated sandbox `gh`, `make_pr`, or a pre-implementation native PR button does not alone fail preflight when repository identity, cleanliness, baseline, and managing-conversation GitHub reads are verified.

If a genuinely required preflight item fails, implementation does not start.

## 5. Design Gate

Before implementation:
- current GitHub/main state is the design basis;
- goal, scope, out-of-scope, affected boundaries, risks, tests and Definition of Done must be explicit;
- security, tenancy, capability, audit, API, schema, state-transition and cost implications must be explicit where relevant;
- no programming begins until user approval;
- the approved Design Check is binding; a material deviation requires STOP + escalation.

## 6. Implementation Gate

After Design Approval:
- use one complete One-Shot prompt;
- use only the approved repository/environment and task scope;
- execute required tests/validation;
- at most one corrective programming pass is allowed for a real implementation/acceptance blocker;
- tooling failures do not create additional corrective code passes;
- missing sandbox GitHub credentials or PR commands do not block implementation if preflight otherwise passed.

## 7. Delivery Gate

Approved sequence:

`implementation → tests → result diff → native Create PR/Create draft PR or another approved healthy GitHub branch/PR path → GitHub review`

Delivery passes only when the implementation exists in an actual GitHub PR targeting the intended base and is independently reviewable.

Not valid as routine recovery/delivery:
- Copy patch / manual patch transfer;
- `git apply` reconstruction;
- using Replit to move or recreate Codex work;
- routine force-push/history rewriting;
- making the user relay commits, patches, source code or routine logs between tools.

If Delivery Gate fails, classify the incident under `docs/TOOLING_RECOVERY_PLAYBOOK.md` and follow that playbook. Do not improvise an alternate path.

## 8. Review / CI Gate

Before merge:
- review the actual GitHub diff;
- verify approved files/scope only;
- verify Design Check compliance;
- verify security, tenancy, capability, audit, accounting integrity, cost and architecture boundaries when applicable;
- verify required GitHub Actions CI/test evidence tied to the exact intended SHA;
- passing CI is necessary but not sufficient when design/security/accounting boundaries are violated.

`CI_CODE_FAILURE` is a PROJECT FAILURE and may use the single corrective programming pass. `CI_INFRA_FAILURE` is a TOOLING FAILURE and follows the recovery playbook.

## 9. Merge Gate

Merge requires:
- Delivery Gate passed;
- Review/CI Gate passed;
- no unresolved workflow blocker;
- no unapproved scope expansion;
- explicit user merge approval when required.

Do not merge solely because CI is green.

## 10. Tooling Failure Classification & Recovery

The recovery principle is:

**GitHub = durable project state. Codex session = disposable executor.**

All incidents must first be classified as:
- **PROJECT FAILURE** — product/code/design/test/security/accounting defect requiring project correction; or
- **TOOLING FAILURE** — authentication, repository connection, session, checkout, delivery, infrastructure, or credit/tool availability failure while project code is not established as defective.

Global tooling rule:

`normal attempt → classify → one tooling retry maximum → fresh Codex session from verified GitHub state → approved fallback / STOP`

No infinite retry loops. No automatic paid credits. Never rebuild a valid durable commit/branch/PR from scratch merely because a session failed.

The canonical incident handling rules and durable/non-durable checkpoint definitions are in:
`docs/TOOLING_RECOVERY_PLAYBOOK.md`.

## 11. Failure-Stop Rules

STOP when:
- a required GitHub baseline/review operation is unavailable and no verified equivalent path exists;
- Codex is attached to the wrong repository/environment or baseline;
- Delivery Gate fails with no approved recovery path;
- the resulting PR cannot be safely created/read/reviewed;
- continuing requires prohibited recovery behavior;
- a second corrective programming pass would be required;
- cost protection would be violated;
- a material authority/document ambiguity remains unresolved.

## 12. Prohibited Recovery Patterns

Unless a separately approved repository-recovery plan explicitly authorizes an exceptional action, do not:
- copy patches between tools for delivery;
- use Replit as a Git bridge or branch reconstruction tool;
- recreate valid durable work from scratch;
- force-push/rewrite history as routine recovery;
- loop repeatedly on auth/session/delivery failures;
- automatically buy or consume additional paid credits;
- make the user manually shuttle routine Git state between systems.

## 13. User Burden Protections

The user is the decision-maker and approver, not a manual integration layer.

Routine delivery and review should use connected product/GitHub tooling. A single native product action such as Codex `Create PR` may be acceptable; any extra manual action must have a genuine reason, be minimal, be explained, and receive explicit agreement.

## 14. Session Health Rule

The managing conversation must demonstrate live GitHub health in that conversation before programming begins. Codex repository identity, checkout health, and PR delivery health are separate stages.

A new Codex session is acceptable as a recovery mechanism when the playbook requires it. Never assume uncommitted/session-local work will survive a failed session.

## 15. Exception Handling

Exceptions must be explicit and narrowly scoped.

- Replit Agent has an exception only to the former absolute prohibition: **FREE MODE ONLY** within the approved operational allowlist and subject to a successful Sync PoC. It has no coding/delivery exception.
- Production deployment and paid services remain subject to explicit user approval.
- Force-push or unusual repository recovery requires a separate recovery plan and explicit approval.
- No exception may silently weaken security, tenant isolation, auditability, accounting integrity, cost controls, or approved Design Check scope.

## 16. Historical Workflow Lesson

Earlier project work demonstrated that technically valid code can coexist with a failed delivery process. That lesson remains historical evidence, but current recovery behavior is governed by the authority hierarchy and `docs/TOOLING_RECOVERY_PLAYBOOK.md`, not by ad-hoc reconstruction of an old incident.

## 17. Post-Merge Closeout Checklist

After an approved merge:
- confirm PR merged;
- read and record the new GitHub/main HEAD;
- confirm merged diff matches approved scope;
- confirm no unexpected files;
- record verified test/CI results;
- record material decisions/exceptions when needed;
- confirm Production was not changed unless approved;
- confirm no new cost was introduced unless approved;
- update current-state documentation only when required by repository policy;
- close the current task technically before opening the next programming task unless a genuine blocker exists.
