import { describe, expect, it } from "vitest";
import { evaluateCommercialLaunchEligibility } from "./commercial-launch-eligibility";

const base = {
  projectId: "MK-PROJECT-001",
  projectOwnerId: "owner-1",
  requests: [{ id: "request-1", projectId: "MK-PROJECT-001", userId: "owner-1" }],
  launches: [{
    requestId: "request-1",
    clientUserId: "owner-1",
    requiredAmount: 20_000,
    confirmedAmountAtLaunch: 20_000,
  }],
};

describe("evaluateCommercialLaunchEligibility", () => {
  it("accepts only an official launch for the exact owner-matched project request with sufficient confirmed funds", () => {
    expect(evaluateCommercialLaunchEligibility(base)).toEqual({ ok: true });
  });

  it("blocks a project without an owner-matched commercial request", () => {
    expect(evaluateCommercialLaunchEligibility({
      ...base,
      requests: [{ ...base.requests[0], projectId: "OTHER-PROJECT" }],
    })).toMatchObject({ ok: false, reason: "request_not_found" });
  });

  it("blocks a request that has no official launch", () => {
    expect(evaluateCommercialLaunchEligibility({ ...base, launches: [] }))
      .toMatchObject({ ok: false, reason: "launch_not_found" });
  });

  it("blocks launches belonging to another client", () => {
    expect(evaluateCommercialLaunchEligibility({
      ...base,
      launches: [{ ...base.launches[0], clientUserId: "other-owner" }],
    })).toMatchObject({ ok: false, reason: "owner_mismatch" });
  });

  it("blocks launches whose confirmed amount is below the required threshold", () => {
    expect(evaluateCommercialLaunchEligibility({
      ...base,
      launches: [{ ...base.launches[0], confirmedAmountAtLaunch: 19_999 }],
    })).toMatchObject({ ok: false, reason: "insufficient_confirmed_payment" });
  });

  it("rejects malformed amounts rather than coercing strings or missing values", () => {
    expect(evaluateCommercialLaunchEligibility({
      ...base,
      launches: [{ ...base.launches[0], requiredAmount: "20000" as never }],
    })).toMatchObject({ ok: false, reason: "invalid_launch_record" });
  });
});
