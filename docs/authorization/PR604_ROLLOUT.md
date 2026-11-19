# PR 604 authorization rollout gate

The release owner records a decision for one exact application SHA and database. Production technical activation and rollback each require independent, explicit approval. Installing the build performs neither transition. A database operator with a named, audited connection runs each approved change on behalf of the identified active System Administrator. The operator credential is separate from application login and company permissions.

## Before cutover

1. On an authorized read-only connection or approved snapshot, inventory active administrators, memberships (including absent/inactive), company activity, role IDs and versions, explicit grants, wildcard flags and the capability catalog. Compare the deployed resolver and candidate resolver for every affected user/company pair on a disposable restored copy, including membershipless admins across every active company. Record per-capability gains and losses, manager membership lists and obsolete stored company.create grants. Keep IDs in the restricted change record. Report counts outside it.
2. Run [the B9 inventory](b9-rollout-inventory.sql) using SQL. Compare **both** digest columns with the target build's constants in server/src/modules/zakat-calculation/zakat-approval-binding.ts. Count pending and approved mismatches (including NULL), approved worksheets and locked packages. A worksheet read can permanently mark a mismatch stale. Hold cutover if any mismatch lacks a separately approved continuity plan. A locked package requires a supported, independently verified treatment before release. Never rewrite attestations, clear staleness, or count an old binding as evidence for new source. The worksheet service is part of the pinned source set even though this PR changes authorization only. Rehearse evidence resubmission and independent review where supported.
3. Verify two separately accessible active administrator accounts and the named operator connection. Rehearse both commands below against a disposable copy with the target binaries, including a version-0 administrator with no memberships. Verify system admin login, access across two companies after activation, denial to company managers outside their company, restricted access after rollback, audit records and recovery after rollback. Hold if any check fails.
4. Obtain approval identifying environment and database, exact old/new SHA, operator identity and application actor, target IDs, companies, expected versions, affected memberships, impact report, change window and separate rollback authority. Freeze concurrent access administration, worksheet activity and related background jobs from the final inventory through verification. Repeat inventory against approved current data and stop on drift.

## Scoped transition

Use the built CLI from the reviewed artifact with AUTHORIZATION_OPERATOR_DATABASE_URL supplied by the secret manager. Verify database host, database name and login against the approval. The application actor UUID identifies the authorizing administrator. PostgreSQL records the actual login as well. The approval reference identifies the independently recorded authorization. A free-text reference alone does not establish approval.

```text
node server/dist/cli/authorization-policy-transition.js DATABASE ACTOR_UUID admin TARGET_ADMIN_UUID global 0 1 APPROVAL_REF
node server/dist/cli/authorization-policy-transition.js DATABASE ACTOR_UUID role TARGET_ROLE_UUID COMPANY_UUID 0 1 APPROVAL_REF
```

Run once for each approved target. Repeating a completed transition returns a version mismatch. After an interruption, inspect both the version and audit record before continuing. Each transaction requires an active global administrator and an exact source version. It updates one row and records one audit event. The role command covers standard Company Manager and Financial Manager rows.

Stage the verified recovery administrators first while the old application is still serving, then switch application versions inside the controlled window. Verify fresh logins and company selection, global administration and company access. Apply approved manager transitions individually and verify delegations in each company. Reopen traffic only after the owner accepts the audit and checks.

## Rollback

Keep the operator connection and recovery accounts available. Freeze writes, inventory B9 against the **rollback** build too, and stop if new attestations would become stale without an approved remedy. Restore the reviewed old application before removing the recovery overlays. Reverse the approved role and administrator transitions using the same commands with versions **1 0** and the rollback approval reference. Verify explicit grants, effective access, operator recovery, both audit streams and Zakat continuity. Rolling back binaries or versions cannot restore a decision already marked stale.
