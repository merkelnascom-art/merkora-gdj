type CommercialRequest = {
  id: string;
  projectId: string;
  userId: string;
};

type CommercialLaunch = {
  requestId: string;
  clientUserId: string;
  requiredAmount: number;
  confirmedAmountAtLaunch: number;
};

export type CommercialLaunchEligibilityInput = {
  projectId: unknown;
  projectOwnerId: unknown;
  requests: readonly unknown[];
  launches: readonly unknown[];
};

export type CommercialLaunchEligibility =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "invalid_project_owner"
        | "request_not_found"
        | "launch_not_found"
        | "owner_mismatch"
        | "invalid_launch_record"
        | "insufficient_confirmed_payment";
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseRequest(value: unknown): CommercialRequest | null {
  if (!isRecord(value) || !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.projectId) || !isNonEmptyString(value.userId)) return null;
  return { id: value.id, projectId: value.projectId, userId: value.userId };
}

function parseLaunch(value: unknown): CommercialLaunch | null {
  if (!isRecord(value) || !isNonEmptyString(value.requestId) ||
    !isNonEmptyString(value.clientUserId) ||
    typeof value.requiredAmount !== "number" || !Number.isSafeInteger(value.requiredAmount) ||
    typeof value.confirmedAmountAtLaunch !== "number" ||
    !Number.isSafeInteger(value.confirmedAmountAtLaunch) ||
    value.requiredAmount <= 0 || value.confirmedAmountAtLaunch < 0) return null;

  return {
    requestId: value.requestId,
    clientUserId: value.clientUserId,
    requiredAmount: value.requiredAmount,
    confirmedAmountAtLaunch: value.confirmedAmountAtLaunch,
  };
}

/**
 * A factory build may start only from a commercial request that belongs to the
 * exact project owner and has an official launch recording the required
 * confirmed-payment threshold. This function performs no I/O or side effects.
 */
export function evaluateCommercialLaunchEligibility(
  input: CommercialLaunchEligibilityInput,
): CommercialLaunchEligibility {
  if (!isNonEmptyString(input.projectId) || !isNonEmptyString(input.projectOwnerId)) {
    return { ok: false, reason: "invalid_project_owner" };
  }

  const requests = input.requests.map(parseRequest).filter(
    (request): request is CommercialRequest => request !== null,
  );
  const matchingRequests = requests.filter((request) =>
    request.projectId === input.projectId && request.userId === input.projectOwnerId,
  );
  if (matchingRequests.length === 0) return { ok: false, reason: "request_not_found" };

  const requestIds = new Set(matchingRequests.map((request) => request.id));
  const matchingLaunches = input.launches.filter((value) =>
    isRecord(value) && typeof value.requestId === "string" && requestIds.has(value.requestId),
  );
  if (matchingLaunches.length === 0) return { ok: false, reason: "launch_not_found" };

  const parsedLaunches = matchingLaunches.map(parseLaunch);
  if (parsedLaunches.some((launch) => launch === null)) {
    return { ok: false, reason: "invalid_launch_record" };
  }

  const ownerLaunches = (parsedLaunches as CommercialLaunch[]).filter(
    (launch) => launch.clientUserId === input.projectOwnerId,
  );
  if (ownerLaunches.length === 0) return { ok: false, reason: "owner_mismatch" };

  if (ownerLaunches.some((launch) =>
    launch.confirmedAmountAtLaunch >= launch.requiredAmount,
  )) return { ok: true };

  return { ok: false, reason: "insufficient_confirmed_payment" };
}
