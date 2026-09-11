const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../dist/index.js");

const SHA = "a".repeat(40);
const contract = {
  baselineSha: SHA, goal: "Build core", scope: ["tools/orchestrator"],
  outOfScope: ["Product"], affectedBoundaries: ["governance"],
  schemaMigrations: "none", acceptanceCriteria: ["deterministic"],
  requiredTests: ["npm test"], humanGates: "none",
  definitionOfDone: ["checks pass"],
};

const preflight = {
  repositoryBound: true, repository: "Sydiha/eqfal", checkedOutSha: SHA,
  workingTreeClean: true, agentsReadable: true, workflowGovernanceReadable: true,
  toolingRecoveryPlaybookReadable: true, unresolvedHumanGate: false,
};

const gate = {
  actualPullRequestTargetsMain: true, approvedLineageMatches: true,
  scopeMatchesContract: true, noUnapprovedExpansion: true, reviewerResult: "PASS",
  ciStatus: "PASS", ciSha: SHA, intendedHeadSha: SHA,
  noUnresolvedProjectBlocker: true, noCorrectnessAffectingToolingBlocker: true,
  noHumanGate: true, noProductionChange: true, noNewPaidCost: true,
  noDestructiveRealDataAction: true, noSecretsOrCredentialsAction: true,
  noSensitiveRealUserPermissionAction: true,
  noMaterialAccountingOrTaxAmbiguity: true, noExceptionalGitRecovery: true,
};

const durableCheckpoint = {
  source: "GITHUB", checkpointType: "OPEN_PULL_REQUEST",
  repository: "Sydiha/eqfal", sha: SHA, githubRef: "pull/177",
};

test("accepts a complete execution contract", () => {
  assert.deepEqual(core.validateExecutionContract(contract), { valid: true, blockers: [] });
});

test("rejects every missing required contract field", () => {
  for (const field of Object.keys(contract)) {
    const incomplete = { ...contract };
    delete incomplete[field];
    const result = core.validateExecutionContract(incomplete);
    assert.equal(result.valid, false, field);
    assert.ok(result.blockers.includes(`CONTRACT_FIELD_MISSING:${field}`), field);
  }
});

test("accepts a valid clean baseline and rejects a mismatch", () => {
  assert.equal(core.validatePreflight(preflight, contract).valid, true);
  const result = core.validatePreflight({ ...preflight, checkedOutSha: "b".repeat(40) }, contract);
  assert.equal(result.valid, false);
  assert.ok(result.blockers.includes("PREFLIGHT_BASELINE_MISMATCH"));
});

test("allows merge only when all 16 gates pass", () => {
  assert.equal(core.MERGE_GATE_IDS.length, 16);
  assert.deepEqual(core.evaluateMergeGate(gate), { mergeAllowed: true, blockers: [] });
});

test("each merge condition independently fails with its gate blocker", () => {
  const mutations = [
    ["actualPullRequestTargetsMain", false], ["approvedLineageMatches", false],
    ["scopeMatchesContract", false], ["noUnapprovedExpansion", false],
    ["reviewerResult", "NEEDS_CORRECTION"], ["ciSha", "b".repeat(40)],
    ["noUnresolvedProjectBlocker", false], ["noCorrectnessAffectingToolingBlocker", false],
    ["noHumanGate", false], ["noProductionChange", false], ["noNewPaidCost", false],
    ["noDestructiveRealDataAction", false], ["noSecretsOrCredentialsAction", false],
    ["noSensitiveRealUserPermissionAction", false],
    ["noMaterialAccountingOrTaxAmbiguity", false], ["noExceptionalGitRecovery", false],
  ];
  mutations.forEach(([field, value], index) => {
    const result = core.evaluateMergeGate({ ...gate, [field]: value });
    assert.equal(result.mergeAllowed, false, field);
    assert.ok(result.blockers.includes(`MERGE_GATE_BLOCKED:${core.MERGE_GATE_IDS[index]}`), field);
  });
});

test("reviewer, CI, and unknown evidence fail closed", () => {
  assert.equal(core.evaluateMergeGate({ ...gate, reviewerResult: "FAIL" }).mergeAllowed, false);
  assert.equal(core.evaluateMergeGate({ ...gate, ciSha: "b".repeat(40) }).mergeAllowed, false);
  assert.equal(core.evaluateMergeGate({}).blockers.length, 16);
});

test("derives the four exact communication states", () => {
  assert.equal(core.deriveNotificationState({ humanGateRequired: true }), "HUMAN DECISION REQUIRED");
  assert.equal(core.deriveNotificationState({ replitSyncAssistanceRequired: true }), "SYNC ASSISTANCE REQUIRED");
  assert.equal(core.deriveNotificationState({ meaningfulIncrementCompleted: true, userValidationRequired: true }), "USER VALIDATION REQUIRED");
  assert.equal(core.deriveNotificationState({ phase: "BUILD" }), "NO ACTION REQUIRED");
});

test("failure classification never authorizes Product scope mutation", () => {
  assert.deepEqual(core.classifyFailure({ code: "CI_CODE_FAILURE" }), {
    category: "PROJECT", code: "CI_CODE_FAILURE", productScopeMutationAllowed: false,
  });
  assert.deepEqual(core.classifyFailure({ code: "AUTH_FAILURE" }), {
    category: "TOOLING", code: "AUTH_FAILURE", productScopeMutationAllowed: false,
  });
});

test("accepts explicit durable GitHub checkpoint evidence", () => {
  assert.deepEqual(core.validateDurableCheckpoint(durableCheckpoint), {
    valid: true, blockers: [],
  });
});

test("missing and unknown durable checkpoint evidence fail closed", () => {
  assert.deepEqual(core.validateDurableCheckpoint(), {
    valid: false, blockers: ["DURABLE_CHECKPOINT_INVALID"],
  });
  const unknown = core.validateDurableCheckpoint({
    ...durableCheckpoint, checkpointType: "EXECUTOR_MEMORY",
  });
  assert.equal(unknown.valid, false);
  assert.ok(unknown.blockers.includes("DURABLE_CHECKPOINT_TYPE_UNKNOWN"));
});

test("session-local evidence can never satisfy a durable checkpoint", () => {
  const result = core.validateDurableCheckpoint({
    ...durableCheckpoint, source: "SESSION_LOCAL",
  });
  assert.equal(result.valid, false);
  assert.ok(result.blockers.includes("DURABLE_CHECKPOINT_SOURCE_NOT_GITHUB"));
});

test("selects deterministic fail-closed lifecycle actions", () => {
  assert.equal(core.nextOrchestratorAction({ phase: "PREFLIGHT" }, { preflight, contract }), "ROUTE_TO_BUILDER");
  assert.equal(core.nextOrchestratorAction({ phase: "MERGE" }, { mergeGate: gate }), "MERGE");
  assert.equal(core.nextOrchestratorAction({ phase: "MERGE" }, {}), "REPORT_BLOCKERS");
  assert.equal(core.nextOrchestratorAction({ phase: "BUILD" }, { durableCheckpoint }), "ROUTE_TO_REVIEWER");
  assert.equal(core.nextOrchestratorAction({ phase: "BUILD" }), "REPORT_BLOCKERS");
  assert.equal(core.nextOrchestratorAction({ phase: "BUILD", humanGateRequired: true }), "STOP_FOR_HUMAN_DECISION");
});
