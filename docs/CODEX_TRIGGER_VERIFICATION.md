# Codex Trigger Verification Playbook

This playbook is an active EQFAL operating rule for every Codex Cloud execution request, including bounded correction runs on an existing pull request.

## Purpose

Prevent silent non-execution caused by posting a GitHub comment that looks like a Codex task but does not actually trigger Codex.

## Mandatory Rule

A GitHub comment is **not** considered a Codex execution request merely because it contains task instructions.

When GitHub mention-based triggering is the selected execution path, the comment must include the recognized Codex mention trigger and must otherwise satisfy the current integration requirements.

EQFAL must never report that Codex has started, that a correction was sent to Codex, or equivalent wording until execution evidence has been independently verified.

## Required Status Distinction

EQFAL must distinguish these states explicitly:

1. **Request posted** — the GitHub instruction/comment exists.
2. **Trigger confirmed** — the posted instruction contains the required Codex trigger and is visible on GitHub.
3. **Execution started** — there is verifiable Codex activity or response tied to that trigger.
4. **PR updated** — GitHub independently confirms a new pull-request HEAD SHA or other expected durable result.

These states must not be collapsed into one another.

## Verification Immediately After Posting

After posting any Codex execution or correction request, EQFAL must perform a read-only verification before telling the Owner that execution has begun:

- confirm the exact comment exists on the intended Issue or PR;
- confirm the recognized Codex trigger is present when required;
- confirm the request refers to the intended repository, PR or branch, and approved HEAD or baseline;
- look for verifiable Codex acknowledgement or activity;
- if execution activity is not visible yet, report only **Request posted / Trigger confirmed**, not **Execution started**.

## No Silent Waiting

If the PR HEAD remains unchanged and no Codex activity is visible, EQFAL must investigate the trigger state before asking the Owner to continue waiting.

A missing or malformed trigger is a coordination failure, not a Codex execution failure. Fix the trigger path; do not consume another Codex run or duplicate a coding prompt unnecessarily.

## Correction Runs

Every new Codex Cloud execution after the initial run still requires fresh explicit Owner Approval under the active governance rules.

Once the Owner approves a correction:

- preserve the approved bounded scope;
- post the correct Codex trigger exactly once;
- verify the trigger immediately;
- verify execution separately;
- verify the resulting PR HEAD separately;
- never merge automatically.

## Owner-Facing Reporting Standard

Use precise status language:

- **تم نشر الطلب** only after GitHub confirms the comment exists.
- **تم تأكيد المحفّز** only after the required trigger syntax is verified.
- **بدأ تنفيذ Codex** only after observable execution evidence exists.
- **تم تحديث PR** only after GitHub independently confirms the new HEAD or result.

If any of these cannot be proven, say so directly and stop at the last verified state.
