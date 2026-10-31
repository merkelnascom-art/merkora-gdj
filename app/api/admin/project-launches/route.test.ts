import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: vi.fn().mockResolvedValue({}) }));
vi.mock("@/lib/server/admin-access", () => ({ getAdminAccess: vi.fn() }));
vi.mock("@/lib/server/supabase-rest", () => ({
  callUserData: vi.fn(), getAccessToken: vi.fn(), isSameOrigin: vi.fn(),
}));

import { getAdminAccess } from "@/lib/server/admin-access";
import { callUserData, getAccessToken, isSameOrigin } from "@/lib/server/supabase-rest";
import { createProjectMemoryDigest } from "@/lib/factory/project-memory-digest";
import { POST } from "./route";

const admin = { id: "admin-1", email: "admin@example.test", fullName: "Admin" };
const invoiceId = "a1c2d3e4-f567-4890-8abc-1234567890ab";
const versionId = "b1c2d3e4-f567-4890-8abc-1234567890ab";
const quoteId = "c1c2d3e4-f567-4890-8abc-1234567890ab";
const requestId = "d1c2d3e4-f567-4890-8abc-1234567890ab";
const launchId = "e1c2d3e4-f567-4890-8abc-1234567890ab";
const projectId = "MK-PROJECT-001";
const ownerId = "owner-1";
const payload = { includedScope: [{ id: "staff", title: "Personnel", description: "Gestion du personnel." }] };
const plan = {
  version: 2, payload,
  payload_digest: createProjectMemoryDigest(payload),
  scope_digest: createProjectMemoryDigest(payload.includedScope),
  source_brief_version: 1,
};
const approvals = ["client_scope", "admin_review", "execution_authorization"].map((approval_kind, index) => ({
  id: `approval-${index + 1}`, project_id: projectId, plan_version: 2,
  approval_kind, decision: "approved", plan_digest: plan.payload_digest,
  scope_digest: plan.scope_digest, ai_processing_consent: approval_kind === "client_scope",
}));
const body = { invoiceId, requiredAmount: 20_000, message: "Démarrage du projet après acompte confirmé." };

function makeRequest() {
  return new Request("https://merkora.test/api/admin/project-launches", {
    method: "POST", headers: { origin: "https://merkora.test", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function mockCommercialFlow(options: { projectLinked?: boolean; consent?: boolean; existingJob?: boolean } = {}) {
  const projectLinked = options.projectLinked !== false;
  const approvalRows = options.consent === false
    ? approvals.map((item) => item.approval_kind === "client_scope" ? { ...item, ai_processing_consent: false } : item)
    : approvals;
  vi.mocked(callUserData).mockImplementation(async (path, method) => {
    if (method === "GET" && path.startsWith("client_invoices?")) return { ok: true, status: 200, data: [{
      id: invoiceId, quote_version_id: versionId, client_user_id: ownerId, total_amount: 78_000, description: "Projet",
    }] };
    if (method === "GET" && path.startsWith("client_quote_versions?select=id,quote_id")) return { ok: true, status: 200, data: [{
      id: versionId, quote_id: quoteId, client_user_id: ownerId, version_number: 2, published_at: "2026-10-01T00:00:00Z",
    }] };
    if (method === "GET" && path.startsWith("client_quote_versions?select=id&quote_id")) return { ok: true, status: 200, data: [{ id: versionId }] };
    if (method === "GET" && path.startsWith("client_quote_decisions?")) return { ok: true, status: 200, data: [{ id: "decision-1", decision: "accepted" }] };
    if (method === "GET" && path.startsWith("client_quotes?")) return { ok: true, status: 200, data: [{ id: quoteId, request_id: requestId, client_user_id: ownerId }] };
    if (method === "GET" && path.startsWith("client_payment_declarations?")) return { ok: true, status: 200, data: [{ id: "payment-1", amount: 20_000 }] };
    if (method === "GET" && path.startsWith("client_payment_reviews?")) return { ok: true, status: 200, data: [{ payment_declaration_id: "payment-1", status: "confirmed" }] };
    if (method === "GET" && path.startsWith("client_project_launches?select=id,launched_at")) return { ok: true, status: 200, data: [] };
    if (method === "POST" && path === "client_project_launches") return { ok: true, status: 201, data: [{ id: launchId }] };
    if (method === "PATCH" && path.startsWith("client_requests?id=")) return { ok: true, status: 200, data: [{ id: requestId }] };
    if (method === "GET" && path.startsWith("client_requests?select=id,user_id,project_id")) return { ok: true, status: 200, data: [{ id: requestId, user_id: ownerId, project_id: projectId }] };
    if (method === "GET" && path.startsWith("user_projects?select=id,user_id")) return { ok: true, status: 200, data: projectLinked ? [{ id: projectId, user_id: ownerId }] : [] };
    if (method === "GET" && path.startsWith("project_memory_plan_versions?select=")) return { ok: true, status: 200, data: [plan] };
    if (method === "GET" && path.startsWith("project_memory_approvals?select=")) return { ok: true, status: 200, data: approvalRows };
    if (method === "GET" && path.startsWith("project_factory_jobs?select=")) return { ok: true, status: 200, data: options.existingJob ? [{ id: "job-existing", status: "queued" }] : [] };
    if (method === "POST" && path === "rpc/create_factory_job_with_tasks") return { ok: true, status: 200, data: { job_id: "job-1", task_count: 5 } };
    return { ok: true, status: 200, data: [] };
  });
}

beforeEach(() => {
  vi.mocked(isSameOrigin).mockReturnValue(true);
  vi.mocked(getAdminAccess).mockResolvedValue({ ok: true, user: admin });
  vi.mocked(getAccessToken).mockResolvedValue("token");
});
afterEach(() => vi.clearAllMocks());

describe("POST /api/admin/project-launches", () => {
  it("atomically queues factory work after a valid official launch and exact client approvals", async () => {
    mockCommercialFlow();
    const response = await POST(makeRequest());
    const result = await response.json();
    expect(response.status).toBe(200);
    expect(result).toMatchObject({ saved: true, factoryHandoff: { status: "queued", jobId: "job-1", taskCount: 5, executionStarted: false } });
    const rpcCall = vi.mocked(callUserData).mock.calls.find(([path]) => path === "rpc/create_factory_job_with_tasks");
    expect(rpcCall).toBeDefined();
    const rpcPayload = rpcCall?.[3] as { p_job: Record<string, unknown>; p_tasks: Array<Record<string, unknown>> };
    expect(rpcPayload.p_job).toMatchObject({ project_id: projectId, correlation_id: launchId, approval_ids: ["approval-1", "approval-2", "approval-3"] });
    expect((rpcPayload.p_job.manifest as Record<string, unknown>).commercialLaunchId).toBe(launchId);
    expect(rpcPayload.p_tasks).toHaveLength(5);
  });

  it("records the commercial launch but does not create a factory job without an exact project link", async () => {
    mockCommercialFlow({ projectLinked: false });
    const response = await POST(makeRequest());
    const result = await response.json();
    expect(response.status).toBe(200);
    expect(result.factoryHandoff.status).toBe("needs_project_link");
    expect(vi.mocked(callUserData).mock.calls.some(([path]) => path === "rpc/create_factory_job_with_tasks")).toBe(false);
  });

  it("does not create a duplicate factory job for the same commercial launch", async () => {
    mockCommercialFlow({ existingJob: true });
    const response = await POST(makeRequest());
    const result = await response.json();
    expect(response.status).toBe(200);
    expect(result.factoryHandoff).toMatchObject({ status: "already_queued", jobId: "job-existing", jobStatus: "queued" });
    expect(vi.mocked(callUserData).mock.calls.some(([path]) => path === "rpc/create_factory_job_with_tasks")).toBe(false);
  });

  it("records the launch but waits when client AI-processing consent is absent", async () => {
    mockCommercialFlow({ consent: false });
    const response = await POST(makeRequest());
    const result = await response.json();
    expect(response.status).toBe(200);
    expect(result.factoryHandoff).toMatchObject({ status: "awaiting_approval", missingConsent: true });
    expect(vi.mocked(callUserData).mock.calls.some(([path]) => path === "rpc/create_factory_job_with_tasks")).toBe(false);
  });
});
