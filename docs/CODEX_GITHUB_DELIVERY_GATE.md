# EQFAL — Codex ↔ GitHub Delivery Gate

Status: Approved project guidance
Date: 2026-09-06

This document records the tested delivery paths for EQFAL and refines the generic Codex/GitHub preflight rules in `docs/EXECUTION_ROADMAP.md`.

## Purpose

No implementation task may begin until its selected Codex delivery path can reach `Sydiha/eqfal`, produce a dedicated branch/commit, and deliver changes to a GitHub Pull Request that can later be updated on the same PR.

If the selected path cannot prove delivery before editing code, stop and repair the delivery path first.

## Local Codex App on Windows — tested and approved

The approved local repository is:

`C:\Users\easar\OneDrive\المستندات\eqfal`

The following path was practically validated on 2026-09-06:

- Git for Windows installed and available in PATH.
- Repository is a real Git working tree.
- `origin` points to `https://github.com/Sydiha/eqfal.git`.
- Local `main` can be synchronized with `origin/main` using fast-forward only.
- GitHub authentication permits push.
- A dedicated branch can be created and pushed.
- A Pull Request can be created from the pushed branch.
- A later commit pushed to the same branch updates the same Pull Request.

The validation PR was #151 and was closed without merge after the test.

### Local preflight before implementation

For a Local task, prove before code changes:

1. The working directory is the approved EQFAL repository.
2. `git status -sb` is understood and no unrelated changes are present.
3. `git remote -v` shows the correct `Sydiha/eqfal` origin for fetch and push.
4. Fetch succeeds.
5. Baseline `main` is synchronized with `origin/main` using a safe fast-forward path when needed.
6. Record the exact baseline SHA.
7. Work on a dedicated branch, never directly on `main`.
8. Push capability is available before substantial implementation starts.
9. Corrective commits remain on the same PR branch.

If any of these fail, stop before implementation.

## Codex Cloud — tested and approved through platform PR handoff

The Codex Cloud Environment `eqfal` is linked to repository `Sydiha/eqfal` through the ChatGPT Codex Connector. The GitHub App installation has read/write access to code, issues, pull requests, workflows, and actions for the repository.

The Cloud sandbox may present a platform-managed working branch such as `work`, may have no `origin` remote inside the shell, and `gh auth status` may report no authenticated GitHub host. Those shell conditions alone are **not** a delivery failure for Cloud.

For Cloud, the authoritative delivery path is the Codex platform handoff:

Cloud task → commit → **Create PR** → follow-up commit → **Update PR** on the same pull request.

This path was practically validated on 2026-09-06. The validation PR was #152; it was created from Codex Cloud, updated from the same Cloud task using **Update PR**, and closed without merge after validation.

### Cloud preflight before implementation

For a Cloud task, prove before substantial code changes:

1. The selected Environment is `eqfal`.
2. The Environment is linked to repository `Sydiha/eqfal`.
3. The requested base in the Codex UI is `main`.
4. The Cloud task can read the expected repository baseline/content.
5. The normal Codex Cloud delivery action is available for creating a PR after a minimal bounded change when delivery needs revalidation.
6. Existing PR work must use **Update PR**, not create a second PR.

Do **not** require native `origin`, `git push`, or authenticated `gh` inside the Cloud sandbox when the platform-managed Create PR / Update PR handoff is functioning.

Do not add a personal GitHub token, PAT, new Secret, paid service, or other credential workaround merely to make the Cloud shell behave like Local Git unless a future documented platform requirement makes that necessary and the project owner explicitly approves it.

## Selection rule

- Local Codex App is the dependable native-Git path and may be used for normal implementation.
- Codex Cloud is also an approved path when the platform Create PR / Update PR handoff is available.
- Choose the path that best fits the task while minimizing token/credit usage and avoiding manual artifact relay.
- If the chosen path fails its own delivery gate, try the other already-approved path only if doing so does not create duplicate implementation work.
- If both paths fail, stop and repair connectivity before coding.

## Token and credit conservation

- Design and scope the task before handing it to Codex.
- Prefer one complete implementation contract.
- Do not use Codex for open-ended discussion that can be settled in project planning first.
- Avoid repeating full project history; reference repository documentation and only the relevant files/decisions.
- Prefer focused diffs and targeted tests; rely on CI for broader verification where appropriate.
- Keep corrective work on the same PR and allow at most one implementation correction for a real blocker before revisiting the design.

## Cost rule

This delivery setup uses the existing Codex, GitHub repository, GitHub App/Connector, Git for Windows, and current project infrastructure. It must not introduce new paid services or recurring infrastructure costs without explicit prior approval.

## Acceptance rule

A task is not accepted merely because Codex reports success. Acceptance requires:

- the actual GitHub PR/diff;
- changed files within approved scope;
- tests/CI appropriate to the risk on the exact head commit;
- comparison with the approved read-only design check;
- no unrelated changes or unauthorized cost/infrastructure additions.
