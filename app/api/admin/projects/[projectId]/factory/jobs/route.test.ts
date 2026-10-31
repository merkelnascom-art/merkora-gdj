import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: vi.fn().mockResolvedValue({}) }));
vi.mock("@/lib/server/admin-access", () => ({ getAdminAccess: vi.fn() }));
vi.mock("@/lib/server/supabase-rest", () => ({
  callUserData: vi.fn(), getAccessToken: vi.fn(), getCurrentUser: vi.fn(), isSameOrigin: vi.fn(),
}));
import { getAdminAccess } from "@/lib/server/admin-access";
import { callUserData, getAccessToken, getCurrentUser, isSameOrigin } from "@/lib/server/supabase-rest";
import { POST } from "./route";

const user = { id: "admin-1", email: "merkelnascom@gmail.com", fullName: "Admin" };
const plan = { version: 3, source_brief_version: 2, payload: { includedScope: [{ id: "attendance" }] }, payload_digest: "a".repeat(64), scope_digest: "b".repeat(64) };
const approvalRows = ["client_scope", "admin_review", "execution_authorization"].map((approval_kind, index) => ({
  id: `approval-${index + 1}`, approval_kind, decision: "approved",
  plan_digest: plan.payload_digest, scope_digest: plan.scope_digest,
  ai_processing_consent: approval_kind === "client_scope",
}));
const body = { planVersion: 3, correlationId: "b2c3d4e5-f678-4123-8abc-1234567890ab" };
const context = { params: Promise.resolve({ projectId: "MK-PROJECT-001" }) };
function makeRequest(value: unknown = body) {
  return new Request("https://merkora.test/api/admin/projects/MK-PROJECT-001/factory/jobs", {
    method: "POST", headers: { origin: "https://merkora.test", "content-type": "application/json" },
    body: JSON.stringify(value),
  });
}
beforeEach(() => {
  vi.mocked(isSameOrigin).mockReturnValue(true);
  vi.mocked(getCurrentUser).mockResolvedValue(user);
  vi.mocked(getAccessToken).mockResolvedValue("token");
  vi.mocked(getAdminAccess).mockResolvedValue({ ok: true, user });
  vi.mocked(callUserData)
    .mockResolvedValueOnce({ ok: true, status: 200, data: [plan] })
    .mockResolvedValueOnce({ ok: true, status: 200, data: approvalRows })
    .mockResolvedValueOnce({ ok: true, status: 200, data: [] })
    .mockResolvedValueOnce({ ok: true, status: 201, data: [{ id: "job-1" }] })
    .mockResolvedValueOnce({ ok: true, status: 201, data: [{ id: "task-1" }] });
});
afterEach(() => vi.clearAllMocks());

describe("POST /api/admin/projects/[projectId]/factory/jobs", () => {
  it("rejects malformed and cross-origin requests", async () => {
    vi.mocked(isSameOrigin).mockReturnValue(false);
    expect((await POST(makeRequest(), context)).status).toBe(403);
    vi.mocked(isSameOrigin).mockReturnValue(true);
    expect((await POST(makeRequest({ planVersion: 0, correlationId: "bad" }), context)).status).toBe(400);
    expect(callUserData).not.toHaveBeenCalled();
  });

  it("requires an administrator", async () => {
    vi.mocked(getAdminAccess).mockResolvedValue({ ok: false, reason: "not_allowed" });
    const response = await POST(makeRequest(), context);
    expect(response.status).toBe(403);
    expect(callUserData).not.toHaveBeenCalled();
  });

  it("blocks job creation until all three exact approvals exist", async () => {
    vi.mocked(callUserData).mockReset()
      .mockResolvedValueOnce({ ok: true, status: 200, data: [plan] })
      .mockResolvedValueOnce({ ok: true, status: 200, data: approvalRows.slice(0, 2) });
    const response = await POST(makeRequest(), context);
    expect(response.status).toBe(409);
    expect((await response.json()).missingApprovals).toEqual(["execution_authorization"]);
    expect(callUserData).toHaveBeenCalledTimes(2);
  });

  it("blocks factory creation when client AI-processing consent is absent", async () => {
    const approvalsWithoutConsent = approvalRows.map((row) =>
      row.approval_kind === "client_scope" ? { ...row, ai_processing_consent: false } : row);
    vi.mocked(callUserData).mockReset()
      .mockResolvedValueOnce({ ok: true, status: 200, data: [plan] })
      .mockResolvedValueOnce({ ok: true, status: 200, data: approvalsWithoutConsent });
    const response = await POST(makeRequest(), context);
    expect(response.status).toBe(409);
    expect((await response.json()).missingConsent).toBe("client_scope");
    expect(callUserData).toHaveBeenCalledTimes(2);
  });

  it("creates a queued job and five tasks without starting execution", async () => {
    const response = await POST(makeRequest(), context);
    const result = await response.json();
    expect(response.status).toBe(200);
    expect(result).toMatchObject({ created: true, jobId: "job-1", status: "queued", taskCount: 5, executionStarted: false });
    const calls = vi.mocked(callUserData).mock.calls;
    expect(calls[3][0]).toBe("project_factory_jobs");
    const jobPayload = calls[3][3] as Record<string, unknown>;
    expect(jobPayload).toMatchObject({
      plan_version: 3, plan_digest: plan.payload_digest, scope_digest: plan.scope_digest,
      requested_by: user.id, authorized_by: user.id,
      approval_ids: ["approval-1", "approval-2", "approval-3"],
    });
    expect((jobPayload.manifest as Record<string, unknown>).approvalIds).toEqual(["approval-1", "approval-2", "approval-3"]);
    expect(calls[4][0]).toBe("project_factory_tasks");
    const taskPayload = calls[4][3] as Array<Record<string, unknown>>;
    expect(taskPayload).toHaveLength(5);
    expect(taskPayload[1]).toMatchObject({ task_key: "generate_application", dependencies: ["prepare_specification"] });
  });

  it("does not create a second job for an existing correlation id", async () => {
    vi.mocked(callUserData).mockReset()
      .mockResolvedValueOnce({ ok: true, status: 200, data: [plan] })
      .mockResolvedValueOnce({ ok: true, status: 200, data: approvalRows })
      .mockResolvedValueOnce({ ok: true, status: 200, data: [{ id: "job-existing" }] });
    const response = await POST(makeRequest(), context);
    expect(response.status).toBe(409);
    expect(callUserData).toHaveBeenCalledTimes(3);
  });
});
