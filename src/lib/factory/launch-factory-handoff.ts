import { createProjectMemoryDigest } from "./project-memory-digest";

type Row = Record<string, unknown>;

export type LaunchFactoryHandoffInput = {
  projectId: string;
  ownerId: string;
  requestId: string;
  requests: readonly unknown[];
  projects: readonly unknown[];
  plans: readonly unknown[];
  approvals: readonly unknown[];
};

export type LaunchFactoryHandoffResult =
  | { status: "needs_project_link" }
  | { status: "awaiting_plan" }
  | { status: "awaiting_approval"; missingApprovals: string[]; missingConsent?: true }
  | {
      status: "ready";
      planVersion: number;
      planDigest: string;
      scopeDigest: string;
      sourceBriefVersion: number | null;
      approvalIds: string[];
    };

const REQUIRED_APPROVALS = ["client_scope", "admin_review", "execution_authorization"] as const;

function isRecord(value: unknown): value is Row {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function digestMatches(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

/**
 * Decides whether an officially launched commercial request can be handed to
 * the factory. No data is written and no job is started by this function.
 */
export function evaluateLaunchFactoryHandoff(
  input: LaunchFactoryHandoffInput,
): LaunchFactoryHandoffResult {
  const requestMatches = input.requests.some((value) =>
    isRecord(value) && value.id === input.requestId &&
    value.project_id === input.projectId && value.user_id === input.ownerId,
  );
  const projectMatches = input.projects.some((value) =>
    isRecord(value) && value.id === input.projectId && value.user_id === input.ownerId,
  );
  if (!requestMatches || !projectMatches) return { status: "needs_project_link" };

  const plan = input.plans.find((value) => {
    if (!isRecord(value) || !Number.isSafeInteger(value.version) || Number(value.version) < 1 ||
      !isRecord(value.payload) || !Array.isArray(value.payload.includedScope) ||
      !digestMatches(value.payload_digest) || !digestMatches(value.scope_digest)) return false;
    return createProjectMemoryDigest(value.payload) === value.payload_digest &&
      createProjectMemoryDigest(value.payload.includedScope) === value.scope_digest;
  });
  if (!isRecord(plan) || !isRecord(plan.payload) ||
    !Number.isSafeInteger(plan.version) || !digestMatches(plan.payload_digest) ||
    !digestMatches(plan.scope_digest)) return { status: "awaiting_plan" };

  const exactApprovals = input.approvals.filter((value) =>
    isRecord(value) && value.project_id === input.projectId &&
    value.plan_version === plan.version && value.decision === "approved" &&
    value.plan_digest === plan.payload_digest && value.scope_digest === plan.scope_digest &&
    typeof value.id === "string",
  ) as Row[];
  const approvalByKind = new Map<string, Row>();
  for (const approval of exactApprovals) {
    if (typeof approval.approval_kind === "string" && !approvalByKind.has(approval.approval_kind)) {
      approvalByKind.set(approval.approval_kind, approval);
    }
  }

  const missingApprovals = REQUIRED_APPROVALS.filter((kind) => !approvalByKind.has(kind));
  const clientApproval = approvalByKind.get("client_scope");
  const missingConsent = clientApproval?.ai_processing_consent !== true;
  if (missingApprovals.length || missingConsent) {
    return {
      status: "awaiting_approval",
      missingApprovals: [...missingApprovals],
      ...(missingConsent ? { missingConsent: true as const } : {}),
    };
  }

  return {
    status: "ready",
    planVersion: Number(plan.version),
    planDigest: plan.payload_digest,
    scopeDigest: plan.scope_digest,
    sourceBriefVersion: Number.isSafeInteger(plan.source_brief_version)
      ? Number(plan.source_brief_version) : null,
    approvalIds: REQUIRED_APPROVALS.map((kind) => String(approvalByKind.get(kind)?.id)),
  };
}
