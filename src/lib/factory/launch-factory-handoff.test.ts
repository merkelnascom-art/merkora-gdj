import { describe, expect, it } from "vitest";
import { createProjectMemoryDigest } from "./project-memory-digest";
import { evaluateLaunchFactoryHandoff } from "./launch-factory-handoff";

const projectId = "MK-PROJECT-001";
const ownerId = "owner-1";
const requestId = "d1c2d3e4-f567-4890-8abc-1234567890ab";
const payload = { includedScope: [{ id: "staff", title: "Personnel", description: "Gestion du personnel." }] };
const plan = {
  version: 2, payload,
  payload_digest: createProjectMemoryDigest(payload),
  scope_digest: createProjectMemoryDigest(payload.includedScope),
  source_brief_version: 1,
};
const approvals = ["client_scope", "admin_review", "execution_authorization"].map((approval_kind, index) => ({
  id: `approval-${index + 1}`, approval_kind, decision: "approved",
  plan_version: 2, plan_digest: plan.payload_digest, scope_digest: plan.scope_digest,
  ai_processing_consent: approval_kind === "client_scope",
}));
const base = {
  projectId, ownerId, requestId,
  requests: [{ id: requestId, project_id: projectId, user_id: ownerId }],
  projects: [{ id: projectId, user_id: ownerId }],
  plans: [plan], approvals,
};

describe("evaluateLaunchFactoryHandoff", () => {
  it("returns a ready handoff only for an exact request, project owner, plan and approvals", () => {
    expect(evaluateLaunchFactoryHandoff(base)).toMatchObject({
      status: "ready", planVersion: 2, planDigest: plan.payload_digest,
      scopeDigest: plan.scope_digest, approvalIds: ["approval-1", "approval-2", "approval-3"],
    });
  });

  it("requires an exact owner-matched request and project", () => {
    expect(evaluateLaunchFactoryHandoff({ ...base, projects: [{ id: projectId, user_id: "other" }] }))
      .toMatchObject({ status: "needs_project_link" });
    expect(evaluateLaunchFactoryHandoff({ ...base, requests: [] }))
      .toMatchObject({ status: "needs_project_link" });
  });

  it("waits when the project has no plan", () => {
    expect(evaluateLaunchFactoryHandoff({ ...base, plans: [] }))
      .toMatchObject({ status: "awaiting_plan" });
  });

  it("waits when approvals are incomplete or belong to another plan digest", () => {
    expect(evaluateLaunchFactoryHandoff({ ...base, approvals: approvals.slice(0, 2) }))
      .toMatchObject({ status: "awaiting_approval" });
    expect(evaluateLaunchFactoryHandoff({
      ...base, approvals: approvals.map((item) => ({ ...item, plan_digest: "f".repeat(64) })),
    })).toMatchObject({ status: "awaiting_approval" });
  });

  it("never treats missing client AI-processing consent as an approval", () => {
    expect(evaluateLaunchFactoryHandoff({
      ...base,
      approvals: approvals.map((item) => item.approval_kind === "client_scope"
        ? { ...item, ai_processing_consent: false } : item),
    })).toMatchObject({ status: "awaiting_approval", missingConsent: true });
  });

  it("rejects a plan whose payload digest no longer matches", () => {
    expect(evaluateLaunchFactoryHandoff({
      ...base, plans: [{ ...plan, payload_digest: "f".repeat(64) }],
    })).toMatchObject({ status: "awaiting_plan" });
  });
});
