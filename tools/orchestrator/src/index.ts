/** Deterministic, executor-agnostic policy core for the EQFAL lifecycle. */

export type ValidationResult = Readonly<{
  valid: boolean;
  blockers: readonly string[];
}>;

export interface ExecutionContract {
  baselineSha?: unknown;
  goal?: unknown;
  scope?: unknown;
  outOfScope?: unknown;
  affectedBoundaries?: unknown;
  schemaMigrations?: unknown;
  acceptanceCriteria?: unknown;
  requiredTests?: unknown;
  humanGates?: unknown;
  definitionOfDone?: unknown;
}

const CONTRACT_FIELDS: ReadonlyArray<keyof ExecutionContract> = [
  "baselineSha",
  "goal",
  "scope",
  "outOfScope",
  "affectedBoundaries",
  "schemaMigrations",
  "acceptanceCriteria",
  "requiredTests",
  "humanGates",
  "definitionOfDone",
];

function isDeclared(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return true;
  return typeof value === "boolean" || typeof value === "object";
}

export function validateExecutionContract(contract: unknown): ValidationResult {
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    return { valid: false, blockers: ["CONTRACT_INVALID"] };
  }
  const candidate = contract as ExecutionContract;
  const blockers = CONTRACT_FIELDS
    .filter((field) => !isDeclared(candidate[field]))
    .map((field) => `CONTRACT_FIELD_MISSING:${field}`);
  if (typeof candidate.baselineSha === "string" &&
      !/^[0-9a-f]{40}$/i.test(candidate.baselineSha)) {
    blockers.push("CONTRACT_BASELINE_SHA_INVALID");
  }
  return { valid: blockers.length === 0, blockers };
}

export interface PreflightEvidence {
  repositoryBound?: unknown;
  repository?: unknown;
  checkedOutSha?: unknown;
  workingTreeClean?: unknown;
  agentsReadable?: unknown;
  workflowGovernanceReadable?: unknown;
  toolingRecoveryPlaybookReadable?: unknown;
  unresolvedHumanGate?: unknown;
}

export function validatePreflight(
  evidence: PreflightEvidence,
  contract: ExecutionContract,
): ValidationResult {
  const blockers = [...validateExecutionContract(contract).blockers];
  const requiredTrue: ReadonlyArray<keyof PreflightEvidence> = [
    "repositoryBound",
    "workingTreeClean",
    "agentsReadable",
    "workflowGovernanceReadable",
    "toolingRecoveryPlaybookReadable",
  ];
  for (const field of requiredTrue) {
    if (evidence?.[field] !== true) blockers.push(`PREFLIGHT_NOT_PROVEN:${field}`);
  }
  if (evidence?.repository !== "Sydiha/eqfal") {
    blockers.push("PREFLIGHT_REPOSITORY_MISMATCH");
  }
  if (evidence?.checkedOutSha !== contract?.baselineSha) {
    blockers.push("PREFLIGHT_BASELINE_MISMATCH");
  }
  if (evidence?.unresolvedHumanGate !== false) {
    blockers.push("PREFLIGHT_HUMAN_GATE_UNRESOLVED");
  }
  return { valid: blockers.length === 0, blockers };
}

const TOOLING_FAILURE_CODES = new Set([
  "AUTH_FAILURE", "REPO_CONNECTION_FAILURE", "BASELINE_MISMATCH",
  "DIRTY_WORKTREE", "STALE_CHECKOUT", "CANNOT_RESUME_TASK",
  "SESSION_FAILURE", "PUSH_FAILURE", "PR_CREATION_FAILURE",
  "CI_INFRA_FAILURE", "CODEX_CREDIT_LIMIT", "PAID_CAPACITY_REQUIRED",
  "REPLIT_SYNC_ASSISTANCE", "EXCEPTIONAL_GIT_RECOVERY",
]);

export const DURABLE_CHECKPOINT_TYPES = Object.freeze([
  "MAIN_COMMIT", "PUSHED_COMMIT", "OPEN_PULL_REQUEST", "CI_EVIDENCE",
  "REVIEW_EVIDENCE",
] as const);

export type DurableCheckpointType = typeof DURABLE_CHECKPOINT_TYPES[number];

/** Evidence must describe state independently readable from GitHub, not an executor session. */
export interface DurableCheckpointEvidence {
  source?: unknown;
  checkpointType?: unknown;
  repository?: unknown;
  sha?: unknown;
  githubRef?: unknown;
}

export function validateDurableCheckpoint(evidence: unknown): ValidationResult {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return { valid: false, blockers: ["DURABLE_CHECKPOINT_INVALID"] };
  }

  const candidate = evidence as DurableCheckpointEvidence;
  const blockers: string[] = [];
  if (candidate.source !== "GITHUB") {
    blockers.push("DURABLE_CHECKPOINT_SOURCE_NOT_GITHUB");
  }
  if (!DURABLE_CHECKPOINT_TYPES.includes(candidate.checkpointType as DurableCheckpointType)) {
    blockers.push("DURABLE_CHECKPOINT_TYPE_UNKNOWN");
  }
  if (typeof candidate.repository !== "string" || candidate.repository.trim().length === 0) {
    blockers.push("DURABLE_CHECKPOINT_REPOSITORY_MISSING");
  }
  if (typeof candidate.sha !== "string" || !/^[0-9a-f]{40}$/i.test(candidate.sha)) {
    blockers.push("DURABLE_CHECKPOINT_SHA_INVALID");
  }
  if (typeof candidate.githubRef !== "string" || candidate.githubRef.trim().length === 0) {
    blockers.push("DURABLE_CHECKPOINT_GITHUB_REF_MISSING");
  }
  return { valid: blockers.length === 0, blockers };
}

export type FailureClassification = Readonly<{
  category: "PROJECT" | "TOOLING";
  code: string;
  productScopeMutationAllowed: false;
}>;

export function classifyFailure(failure: unknown): FailureClassification {
  const input = failure && typeof failure === "object"
    ? failure as { code?: unknown; category?: unknown }
    : {};
  const code = typeof input.code === "string" && input.code.trim()
    ? input.code.trim().toUpperCase()
    : "UNKNOWN_FAILURE";
  // Only explicit tooling evidence receives TOOLING classification; uncertainty
  // is treated as a Product blocker rather than bypassing corrective controls.
  const tooling = input.category === "TOOLING" || TOOLING_FAILURE_CODES.has(code);
  return { category: tooling ? "TOOLING" : "PROJECT", code, productScopeMutationAllowed: false };
}

export interface MergeGateEvidence {
  actualPullRequestTargetsMain?: unknown;
  approvedLineageMatches?: unknown;
  scopeMatchesContract?: unknown;
  noUnapprovedExpansion?: unknown;
  reviewerResult?: unknown;
  ciStatus?: unknown;
  ciSha?: unknown;
  intendedHeadSha?: unknown;
  noUnresolvedProjectBlocker?: unknown;
  noCorrectnessAffectingToolingBlocker?: unknown;
  noHumanGate?: unknown;
  noProductionChange?: unknown;
  noNewPaidCost?: unknown;
  noDestructiveRealDataAction?: unknown;
  noSecretsOrCredentialsAction?: unknown;
  noSensitiveRealUserPermissionAction?: unknown;
  noMaterialAccountingOrTaxAmbiguity?: unknown;
  noExceptionalGitRecovery?: unknown;
}

export type MergeGateResult = Readonly<{
  mergeAllowed: boolean;
  blockers: readonly string[];
}>;

export const MERGE_GATE_IDS = Object.freeze([
  "PR_TARGETS_MAIN", "APPROVED_LINEAGE", "SCOPE_MATCHES_CONTRACT",
  "NO_UNAPPROVED_EXPANSION", "REVIEWER_PASS", "CI_PASS_EXACT_SHA",
  "NO_PROJECT_BLOCKER", "NO_TOOLING_BLOCKER", "NO_HUMAN_GATE",
  "NO_PRODUCTION_CHANGE", "NO_NEW_PAID_COST", "NO_DESTRUCTIVE_DATA_ACTION",
  "NO_SECRETS_ACTION", "NO_SENSITIVE_PERMISSION_ACTION",
  "NO_ACCOUNTING_TAX_AMBIGUITY", "NO_EXCEPTIONAL_GIT_RECOVERY",
] as const);

export function evaluateMergeGate(evidence: MergeGateEvidence): MergeGateResult {
  const passes = [
    evidence?.actualPullRequestTargetsMain === true,
    evidence?.approvedLineageMatches === true,
    evidence?.scopeMatchesContract === true,
    evidence?.noUnapprovedExpansion === true,
    evidence?.reviewerResult === "PASS",
    evidence?.ciStatus === "PASS" && typeof evidence.ciSha === "string" &&
      evidence.ciSha.length > 0 && evidence.ciSha === evidence.intendedHeadSha,
    evidence?.noUnresolvedProjectBlocker === true,
    evidence?.noCorrectnessAffectingToolingBlocker === true,
    evidence?.noHumanGate === true,
    evidence?.noProductionChange === true,
    evidence?.noNewPaidCost === true,
    evidence?.noDestructiveRealDataAction === true,
    evidence?.noSecretsOrCredentialsAction === true,
    evidence?.noSensitiveRealUserPermissionAction === true,
    evidence?.noMaterialAccountingOrTaxAmbiguity === true,
    evidence?.noExceptionalGitRecovery === true,
  ];
  const blockers = MERGE_GATE_IDS.filter((_, index) => !passes[index])
    .map((id) => `MERGE_GATE_BLOCKED:${id}`);
  return { mergeAllowed: blockers.length === 0, blockers };
}

export type NotificationState = "NO ACTION REQUIRED" | "SYNC ASSISTANCE REQUIRED" |
  "HUMAN DECISION REQUIRED" | "USER VALIDATION REQUIRED";

export interface OrchestratorState {
  humanGateRequired?: unknown;
  replitSyncAssistanceRequired?: unknown;
  meaningfulIncrementCompleted?: unknown;
  userValidationRequired?: unknown;
  phase?: "PREFLIGHT" | "BUILD" | "REVIEW" | "CI" | "MERGE" | "POST_MERGE" | "COMPLETE";
}

export function deriveNotificationState(state: OrchestratorState): NotificationState {
  if (state?.humanGateRequired === true) return "HUMAN DECISION REQUIRED";
  if (state?.replitSyncAssistanceRequired === true) return "SYNC ASSISTANCE REQUIRED";
  if (state?.meaningfulIncrementCompleted === true || state?.userValidationRequired === true) {
    return "USER VALIDATION REQUIRED";
  }
  return "NO ACTION REQUIRED";
}

export type OrchestratorAction = "STOP_FOR_HUMAN_DECISION" | "REQUEST_REPLIT_SYNC" |
  "REQUEST_USER_VALIDATION" | "RUN_PREFLIGHT" | "ROUTE_TO_BUILDER" |
  "ROUTE_TO_REVIEWER" | "WAIT_FOR_CI" | "MERGE" | "REPORT_BLOCKERS" |
  "COORDINATE_RUNTIME_VALIDATION" | "REPORT_COMPLETE";

export function nextOrchestratorAction(
  state: OrchestratorState,
  evidence: {
    preflight?: PreflightEvidence;
    contract?: ExecutionContract;
    durableCheckpoint?: DurableCheckpointEvidence;
    mergeGate?: MergeGateEvidence;
  } = {},
): OrchestratorAction {
  const notification = deriveNotificationState(state);
  if (notification === "HUMAN DECISION REQUIRED") return "STOP_FOR_HUMAN_DECISION";
  if (notification === "SYNC ASSISTANCE REQUIRED") return "REQUEST_REPLIT_SYNC";
  if (notification === "USER VALIDATION REQUIRED") return "REQUEST_USER_VALIDATION";
  switch (state?.phase) {
    case "PREFLIGHT":
      if (!evidence.preflight || !evidence.contract) return "RUN_PREFLIGHT";
      return validatePreflight(evidence.preflight, evidence.contract).valid
        ? "ROUTE_TO_BUILDER" : "REPORT_BLOCKERS";
    case "BUILD":
      return validateDurableCheckpoint(evidence.durableCheckpoint).valid
        ? "ROUTE_TO_REVIEWER" : "REPORT_BLOCKERS";
    case "REVIEW": return "WAIT_FOR_CI";
    case "CI":
    case "MERGE":
      return evidence.mergeGate && evaluateMergeGate(evidence.mergeGate).mergeAllowed
        ? "MERGE" : "REPORT_BLOCKERS";
    case "POST_MERGE": return "COORDINATE_RUNTIME_VALIDATION";
    case "COMPLETE": return "REPORT_COMPLETE";
    default: return "RUN_PREFLIGHT";
  }
}
