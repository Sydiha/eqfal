# EQFAL Workflow Governance

This document defines the mandatory delivery governance for EQFAL tasks. It complements `AGENTS.md` and does not weaken any existing repository, security, tenancy, cost, approval, or Replit restrictions.

## 1. Roles of Chat / Codex / GitHub / Replit

### Chat

ChatGPT acts as Lead PM for task framing, Design Checks, scope control, decision-making, review, governance, and routing. Chat does not replace the approved code-delivery path and must not turn the user into a manual bridge between tools.

### Codex

Codex is the implementation tool for programming work after Design Approval. It must work against the approved repository/environment and deliver through the approved GitHub branch/PR path. In Codex Cloud, PR delivery may be exposed through the task result screen via native `Create PR` / `Create draft PR` UI rather than through a sandbox `git remote` or `make_pr` command.

### GitHub

GitHub is the permanent delivery system of record. `main` is the only authoritative merged baseline. Branches, commits, pull requests, diffs, reviews, CI, merge state, and delivery history must be verified from GitHub rather than reconstructed from summaries or local workspaces.

### Replit

Replit Agent is prohibited. Manual Replit Shell/Runtime/Preview may be used only for execution, Preview, or practical validation when needed. Replit is not a Git delivery bridge, branch reconstruction tool, patch relay, or PR rescue path.

## 2. Standard Task Lifecycle

The standard lifecycle for a programming task is:

1. Task definition and scope.
2. Mandatory Delivery Preflight in the managing conversation and verified Codex checkout.
3. Read-only Design Check.
4. Explicit Design Approval.
5. One-Shot Codex implementation against the approved repository/environment.
6. Required tests and validation.
7. Review the Codex result diff.
8. Delivery Gate: deliver through Codex native `Create PR` / `Create draft PR` or another approved healthy GitHub branch/PR path.
9. Confirm the created GitHub PR targets `main` and is independently reviewable.
10. GitHub diff review and Design Check compliance review.
11. CI verification.
12. Explicit merge approval.
13. Merge.
14. Post-merge closeout and baseline update.

Documentation-only governance tasks may be performed directly through a healthy GitHub connector when no programming implementation is involved and the repository can be updated cleanly through branch + commit + PR.

## 3. Mandatory Preflight Checklist

Before any programming task begins, the Lead PM must verify the authoritative baseline through actual GitHub operations in the managing conversation and verify the Codex checkout used for implementation:

- [ ] Repository `Sydiha/eqfal` is accessible.
- [ ] `main` is accessible.
- [ ] Latest `main` HEAD SHA is read and recorded.
- [ ] `AGENTS.md` is read from that `main`.
- [ ] `docs/WORKFLOW_GOVERNANCE.md` is readable from that `main`.
- [ ] GitHub connector/session health is demonstrated by successful live reads.
- [ ] PR read capability is available from the managing GitHub connector.
- [ ] The Codex task is attached to the intended repository/environment or verified checkout.
- [ ] The Codex checkout is clean.
- [ ] The Codex checkout HEAD exactly matches the recorded approved `main` baseline before implementation begins.

A connector shown as “Connected” in settings does not satisfy this checklist by itself.

PR **delivery** capability is not a Mandatory Preflight requirement. It is evaluated at the Delivery Gate after implementation and required tests. Codex does not need an authenticated sandbox `git remote`, authenticated sandbox `gh`, `make_pr`, or visible native `Create PR` button before implementation begins when the managing conversation has completed the live GitHub checks and the Codex checkout identity, cleanliness, and baseline SHA are verified.

If an actually required preflight item above fails, the programming task does not start.

## 4. Design Gate

Before implementation:

- Current `main` is the design baseline.
- The exact task goal, scope, out-of-scope items, affected boundaries, risks, required tests, and Definition of Done must be defined.
- Security, tenancy, capability, audit, API, schema, state-transition, and cost implications must be explicit where relevant.
- No programming work begins until the user approves the Design Check.
- Once approved, the Design Check is binding. Any required deviation must stop the task and be escalated before implementation continues.

## 5. Implementation Gate

After Design Approval:

- The implementation instruction to Codex must be one complete One-Shot prompt.
- The task must run against the approved and preflight-verified repository/environment or checkout.
- Only the approved programming task may be changed.
- Required tests must actually be executed and verified.
- At most one corrective programming pass is allowed under the existing Zero-Loop Rule.
- Tooling or delivery problems are not reasons to redesign or repeatedly reimplement code.
- Missing sandbox GitHub credentials or PR commands do not block implementation when the Mandatory Preflight Checklist passed; PR delivery is evaluated later at the Delivery Gate.

## 6. Delivery Gate

The approved Codex Cloud delivery sequence is:

`implementation → tests → result diff → native Create PR/Create draft PR → GitHub PR review`

An equivalent healthy direct GitHub branch/PR delivery path is also acceptable when available and verified.

The task passes the Delivery Gate only when the implementation is present in an actual GitHub PR targeting the intended base and is independently reviewable from GitHub.

Codex Cloud may not configure a normal sandbox `git remote`, authenticate sandbox `gh`, or expose an in-task `make_pr` command. Those absences do not invalidate completed implementation or tests by themselves.

At this gate, check whether the Codex result exposes native `Create PR` / `Create draft PR` delivery or whether another approved healthy GitHub branch/PR path is available.

A single explicit user action to press Codex native `Create PR` / `Create draft PR` after reviewing the task result is an approved product action and does not violate the User Burden Rule.

If the task result does not expose Codex native PR delivery and no other approved GitHub branch/PR path is available, the Delivery Gate has failed. Stop there. The completed implementation must not be moved through a prohibited recovery route.

The following are not valid substitutes for a failed Delivery Gate:

- `Copy patch` or manual patch copy/paste;
- `Copy git apply`, `git apply`, or equivalent patch handoff;
- moving code through Replit;
- reconstructing a Codex branch in Replit;
- force-pushing as routine delivery repair;
- asking the user to transfer commits, patches, or logs between tools.

## 7. Review / CI Gate

Before merge approval:

- Review the actual GitHub diff, not only an implementation summary or only the Codex result diff.
- Verify that only approved files/scope changed.
- Verify Design Check compliance.
- Verify security, tenancy, capability, audit, cost, and architecture boundaries when applicable.
- Verify the required test and build evidence from GitHub/CI or another explicitly approved verification source.
- Treat passing tests as necessary but not sufficient when the implementation violates the approved design.

If review reveals a genuine implementation blocker, one corrective programming pass is allowed. A second corrective programming pass requires stopping the programming task under the Zero-Loop Rule.

## 8. Merge Gate

Merge requires all of the following:

- Delivery Gate passed.
- Review/CI Gate passed.
- No unresolved workflow blocker.
- No unapproved scope expansion.
- Explicit user merge approval when the workflow requires it.

Do not merge solely because CI is green. Do not merge work whose delivery path or final diff cannot be independently verified.

## 9. Failure-Stop Rules

Stop the task immediately when any of the following occurs:

- GitHub connector/session becomes unavailable for required baseline or review operations and no verified equivalent path exists.
- The Codex task is attached to the wrong repository/environment or the checkout does not match the approved baseline before implementation.
- At the Delivery Gate, Codex native PR delivery is absent or fails and no other approved GitHub branch/PR path is available.
- The resulting PR cannot be created, read, updated, or safely reviewed as required.
- The PR delivery path becomes invalid or cannot be safely repaired through the normal GitHub workflow.
- A second corrective programming pass would be required.
- Continuing would require a prohibited recovery pattern.

Do **not** classify missing sandbox `git remote`, unauthenticated sandbox `gh`, missing in-task `make_pr`, or lack of a visible pre-implementation native PR action alone as a workflow/tooling incident when the Mandatory Preflight Checklist has otherwise passed. PR delivery is evaluated after implementation at the Delivery Gate.

When a real delivery failure occurs, classify it as a workflow/tooling incident. Do not disguise it as a code-fix task.

## 10. Prohibited Recovery Patterns

The following are prohibited as normal or emergency shortcuts unless a separately approved repository-recovery plan explicitly authorizes an exceptional action:

- Copying patch text from one tool to another for delivery.
- Using Codex `Copy patch` as the delivery path.
- Using Codex `Copy git apply`, `git apply`, equivalent patch reconstruction, or manual patch replay as the delivery path.
- Using Replit as a Git bridge for Codex work.
- Recreating Codex branches in Replit to rescue delivery.
- Rewriting or force-pushing branch history to repair routine delivery failures.
- Repeatedly asking the user to run Git commands to move work between tools.
- Repeatedly asking the user to copy logs, SHAs, commits, diffs, or terminal output between tools.
- Continuing delivery attempts after the actual Delivery Gate is known to be broken.

## 11. User Burden Protections

The user is the decision-maker and approver, not a manual integration layer.

Accordingly:

- Routine delivery must be handled by connected product/GitHub tooling.
- A single native Codex `Create PR` / `Create draft PR` action by the user after reviewing the result is an approved part of the normal product workflow.
- The user should not be asked to transfer patches, commits, logs, or SHAs between ChatGPT, Codex, GitHub, and Replit.
- The user should not be asked to perform routine Git delivery commands on behalf of the workflow.
- If manual action beyond the native product delivery UI is genuinely unavoidable, explain the blocker, why no compliant direct path exists, the exact minimal action requested, and the risk. Proceed only after the user's explicit agreement.

## 12. Session Health Rule

The conversation that will manage a programming task must demonstrate live GitHub health through successful reads in that same conversation.

For Codex Cloud, repository identity, implementation checkout health, and delivery health are evaluated as separate stages:

- before implementation, the managing conversation must have live GitHub read access for baseline/review;
- before implementation, the Codex checkout must be identified, clean, and exactly match the approved `main` baseline;
- missing sandbox `git remote`, authenticated sandbox `gh`, or `make_pr` does not invalidate implementation preflight on its own;
- after implementation and tests, Codex native `Create PR` / `Create draft PR` UI or another approved GitHub branch/PR path is evaluated at the Delivery Gate.

If the GitHub review connector is inaccessible and no verified equivalent review path exists, do not begin implementation. If PR delivery is unavailable after implementation, stop at the Delivery Gate without using a prohibited recovery path.

A new conversation/session may be opened only when there is a genuine technical session-health reason, and the relevant preflight must then be repeated.

## 13. Exception Handling

Exceptions must be rare and explicit.

- Replit Agent has no exception path; it remains prohibited.
- Production deployment and new paid services remain subject to their existing explicit-approval rules.
- Force-push or unusual repository recovery is not a routine exception. If repository recovery appears necessary, stop the task and define a separate recovery plan with explicit user approval before any destructive or history-rewriting action.
- An exception to a workflow step must never silently weaken security, tenant isolation, auditability, cost controls, or Design Check compliance.
- If an exception is approved, record what changed, why it was necessary, who approved it, and how normal workflow will be restored.

## 14. Workflow Lesson Learned — Phase 4B

Phase 4B produced a technically successful result but exposed a delivery-process failure that must not be repeated.

In summary:

- Codex reached local completion, but the native Codex PR-delivery path was not used as the authoritative delivery mechanism.
- The implementation branch was subsequently updated from outside Codex.
- Recovery then relied on patch transfer, `git apply`, Replit as an intermediary, and force-push behavior.
- The final technical state succeeded, but the recovery workflow was considered unacceptable because it was fragile, difficult to verify end-to-end, and placed avoidable integration burden on the user.
- A later workflow review confirmed that Codex Cloud can expose PR creation through the result-screen `Create PR` / `Create draft PR` UI even when the sandbox itself does not expose a normal `git remote` or `make_pr` action.

The rules in `AGENTS.md` and this document therefore distinguish between **baseline/checkout preflight** and **post-implementation PR delivery**. They preserve the prohibition on improvised patch/Replit/force-push recovery while allowing Codex implementation to proceed on a verified checkout even when sandbox GitHub credentials are absent.

This lesson is process-focused and assigns no blame to any person or tool.

## 15. Post-Merge Closeout Checklist

After an approved merge:

- [ ] Confirm the PR is merged.
- [ ] Read and record the new `main` HEAD SHA.
- [ ] Confirm the merged diff matches the approved task scope.
- [ ] Confirm no unexpected files were included.
- [ ] Record test/CI results that were actually verified.
- [ ] Record any material decisions or exceptions.
- [ ] Confirm Production was not changed unless separately approved.
- [ ] Confirm no new paid service or operating cost was introduced unless separately approved.
- [ ] Update project recap/decision documentation only when the repository's documentation policy requires it.
- [ ] Close the current task technically before opening the next task unless a genuine blocker justifies otherwise.
