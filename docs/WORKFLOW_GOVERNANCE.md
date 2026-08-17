# EQFAL Workflow Governance

This document defines the mandatory delivery governance for EQFAL tasks. It complements `AGENTS.md` and does not weaken any existing repository, security, tenancy, cost, approval, or Replit restrictions.

## 1. Roles of Chat / Codex / GitHub / Replit

### Chat

ChatGPT acts as Lead PM for task framing, Design Checks, scope control, decision-making, review, governance, and routing. Chat does not replace the approved code-delivery path and must not turn the user into a manual bridge between tools.

### Codex

Codex is the implementation tool for programming work after Design Approval. It must work from an independent branch and deliver through the approved GitHub branch/PR path. It is responsible for the implementation, required tests, commit, and push/update needed for GitHub review.

### GitHub

GitHub is the permanent delivery system of record. `main` is the only authoritative merged baseline. Branches, commits, pull requests, diffs, reviews, CI, merge state, and delivery history must be verified from GitHub rather than reconstructed from summaries or local workspaces.

### Replit

Replit Agent is prohibited. Manual Replit Shell/Runtime/Preview may be used only for execution, Preview, or practical validation when needed. Replit is not a Git delivery bridge, branch reconstruction tool, patch relay, or PR rescue path.

## 2. Standard Task Lifecycle

The standard lifecycle for a programming task is:

1. Task definition and scope.
2. Mandatory Delivery Preflight in the same conversation.
3. Read-only Design Check.
4. Explicit Design Approval.
5. One-Shot Codex implementation on an independent branch.
6. Required tests and validation.
7. Commit and push to the approved branch.
8. Existing/new PR to `main`.
9. GitHub diff review and Design Check compliance review.
10. CI verification.
11. Explicit merge approval.
12. Merge.
13. Post-merge closeout and baseline update.

Documentation-only governance tasks may be performed directly through a healthy GitHub connector when no programming implementation is involved and the repository can be updated cleanly through branch + commit + PR.

## 3. Mandatory Preflight Checklist

Before any programming task begins, the Lead PM must verify through actual GitHub operations in the same conversation:

- [ ] Repository `Sydiha/eqfal` is accessible.
- [ ] `main` is accessible.
- [ ] Latest `main` HEAD SHA is read and recorded.
- [ ] `AGENTS.md` is read from that `main`.
- [ ] Branch creation capability required by the task is available.
- [ ] PR read capability is available.
- [ ] PR create capability is available when a new PR may be required.
- [ ] PR update capability is available when an existing PR may be updated.
- [ ] GitHub connector/session health is demonstrated by successful live reads.
- [ ] No known blocker exists between implementation branch and PR delivery.

A connector shown as “Connected” in settings does not satisfy this checklist by itself.

If any required item fails, the programming task does not start.

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
- The task must use one independent branch.
- Only the approved programming task may be changed.
- Required tests must actually be executed and verified.
- At most one corrective programming pass is allowed under the existing Zero-Loop Rule.
- Tooling or delivery problems are not reasons to redesign or repeatedly reimplement code.

## 6. Delivery Gate

The required delivery sequence is:

`implementation → tests → commit → push → existing/new PR`

The task passes the Delivery Gate only when the implementation is present on the intended GitHub branch and is reviewable through the intended PR path.

If Codex reports local completion but cannot deliver the commit/branch/PR state to GitHub, the Delivery Gate has failed. Stop there.

The following are not valid substitutes for a failed Delivery Gate:

- manual patch copy/paste;
- `git apply` or equivalent patch handoff;
- moving code through Replit;
- reconstructing a Codex branch in Replit;
- force-pushing as routine delivery repair;
- asking the user to transfer commits, patches, or logs between tools.

## 7. Review / CI Gate

Before merge approval:

- Review the actual GitHub diff, not only an implementation summary.
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

- GitHub connector/session becomes unavailable for required delivery operations.
- The approved branch cannot be created, read, updated, or delivered as required.
- Codex cannot commit/push/update the intended GitHub branch or PR.
- The PR delivery path becomes invalid or cannot be safely repaired through the normal GitHub workflow.
- A second corrective programming pass would be required.
- Continuing would require a prohibited recovery pattern.

When stopped, classify the issue as a workflow/tooling incident. Do not disguise it as a code-fix task.

## 10. Prohibited Recovery Patterns

The following are prohibited as normal or emergency shortcuts unless a separately approved repository-recovery plan explicitly authorizes an exceptional action:

- Copying patch text from one tool to another for delivery.
- `git apply`, equivalent patch reconstruction, or manual patch replay as the delivery path.
- Using Replit as a Git bridge for Codex work.
- Recreating Codex branches in Replit to rescue delivery.
- Rewriting or force-pushing branch history to repair routine delivery failures.
- Repeatedly asking the user to run Git commands to move work between tools.
- Repeatedly asking the user to copy logs, SHAs, commits, diffs, or terminal output between tools.
- Continuing implementation after the delivery channel is known to be broken.

## 11. User Burden Protections

The user is the decision-maker and approver, not a manual integration layer.

Accordingly:

- Routine delivery must be handled by the connected tools.
- The user should not be asked to transfer patches, commits, logs, or SHAs between ChatGPT, Codex, GitHub, and Replit.
- The user should not be asked to perform routine Git delivery commands on behalf of the workflow.
- If a manual user action is genuinely unavoidable, explain the blocker, why no compliant direct path exists, the exact minimal action requested, and the risk. Proceed only after the user's explicit agreement.

## 12. Session Health Rule

The conversation that will manage a programming task must demonstrate live GitHub health through successful reads in that same conversation.

If GitHub tools are disabled, inaccessible, stale, or unable to perform the operations required for the task:

- do not begin implementation;
- do not rely on a previous conversation's connector state as proof of current health;
- a new conversation may be opened only when there is a genuine technical session-health reason;
- repeat the full Mandatory Preflight in the new conversation before continuing.

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

- Codex reached local completion, but that completion was not directly publishable through the expected GitHub delivery path.
- The implementation branch was subsequently updated from outside Codex.
- The expected Update PR flow became invalid for the task state.
- Recovery then relied on patch transfer, `git apply`, Replit as an intermediary, and force-push behavior.
- The final technical state succeeded, but the delivery workflow was considered unacceptable because it was fragile, difficult to verify end-to-end, and placed avoidable integration burden on the user.

The rules in `AGENTS.md` and this document are intended to prevent recurrence by requiring verified delivery health before coding, stopping immediately when the delivery channel fails, and prohibiting improvised patch/Replit/force-push recovery chains.

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
