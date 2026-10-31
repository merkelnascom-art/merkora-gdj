# MerKora GDJ — Release reconciliation

Date: 2026-10-31
Branch: `feature/merkora-integration-reconciliation`
Base: `feature/admin-preview-secure-access`

## Purpose

This branch is the protected integration line for reconciling the validated commercial workflow with the multi-provider orchestration work. It deliberately starts from `feature/admin-preview-secure-access` so the quote, invoice, confirmed-payment and official-launch implementation is retained as the baseline.

This branch is not a production release and must not be promoted until the verification gates below pass.

## Verified starting points

### Commercial baseline retained

- Quote publication and client acceptance are part of the commercial branch.
- Invoice and confirmed-payment review are part of the commercial branch.
- `POST /api/admin/project-launches` verifies the published/latest quote version, client acceptance, invoice ownership, confirmed payment threshold and duplicate launch before recording the launch.
- The launch stores `request_id`, `client_user_id`, `quote_version_id`, `invoice_id`, `launched_by`, required amount and confirmed amount.
- The route updates the request status to `in_progress` after launch.
- The validated Love Ways record must remain unchanged: 78,000 FCFA invoice, 20,000 FCFA confirmed payment, 20,000 FCFA launch threshold and 58,000 FCFA remaining.

### Factory and orchestration foundations

- Factory plans and approvals are bound to `project_id`, plan version, plan digest and scope digest.
- Factory job creation requires the three exact approvals: `client_scope`, `admin_review`, `execution_authorization`.
- The current factory endpoint creates a queued job and its tasks; it explicitly returns `executionStarted: false`.
- The worker scheduler is a deterministic selection policy only. It does not claim a database lease or execute a task.
- The orchestration branch contains provider adapters and a server-side runtime for OpenAI, Anthropic and Gemini, guarded by `MERKORA_AGENT_RUNTIME_ENABLED`.
- Provider credentials are not yet durably persisted. The AES-GCM vault is only a cryptographic primitive; the connection manager remains in-memory.

## Integration rules

1. Do not replace or rewrite the commercial quote, invoice, payment-review or launch endpoints.
2. Do not infer that `client_project_launches.request_id` is the same identifier as `user_projects.id`. Verify the actual relational mapping and ownership from schema and records before linking a launch to a factory project.
3. Do not create a factory job from a launch until the exact plan version and all three approvals for that same project are verified.
4. The launch-to-factory handoff must be idempotent. Use a stable correlation key derived from the launch identity and enforce uniqueness in the database.
5. Job and task creation must be atomic or have a tested, explicit compensation/reconciliation path. The current two-request insert can leave a queued job without all tasks.
6. A commercial launch may enqueue work; it must not itself call a model, execute generated code, write to a customer repository or deploy.
7. Every worker claim must be atomic and lease-based. It must re-check job state, approvals, consent, budgets and task dependencies at the persistence boundary.
8. Model-provider calls must remain disabled until server-side configuration, consent, budgets, durable credentials, audit redaction and failure handling are verified.
9. External side effects (GitHub writes, infrastructure changes, deployment, delivery) require a distinct human authorization and must not be auto-selected by the worker.
10. Preserve all customer data and existing Supabase objects. No reset, destructive migration or broad RLS policy replacement.

## Required implementation sequence

### Gate A — prove the relationship (read-only)

- Inspect the definitions and foreign keys for `client_project_launches`, `client_requests`, `user_projects`, `project_memory_plan_versions`, `project_memory_approvals` and `project_factory_jobs`.
- Determine whether a launched request maps to one `user_projects` row and how that mapping is established.
- Inspect the two existing launch records and confirm neither is reprocessed.
- If no safe mapping exists, add an explicit, reviewed association mechanism; do not guess by email, title or client-supplied ID.

### Gate B — implement a safe handoff

- Add an idempotent server-side handoff service.
- Revalidate administrator identity, launch ownership, plan digests, three approvals and AI-processing consent.
- Use a transactional database function or a durable outbox with a reconciliation worker; do not rely on two unrelated REST inserts.
- Persist the launch-to-job association and audit event.
- Keep the existing launch endpoint response and commercial behavior compatible.

### Gate C — durable execution

- Implement a durable worker with atomic leases, lease expiry, retry/backoff, dead-letter handling, bounded concurrency, per-project budgets and cancellation.
- Persist task attempts, safe error codes, evidence references and state transitions.
- Run only tasks that are dependency-ready and approved.
- Keep delivery review and production deployment behind separate human approval.
- Do not use in-memory connection state as the source of truth.

### Gate D — multi-provider runtime

- Bring over the provider adapters and orchestration modules as a reviewed, coherent unit.
- Add durable connection metadata and encrypted credential persistence with strict owner/project/capability scoping.
- Keep secrets server-only; never return credentials or ciphertext to browser clients.
- Configure one provider and one model alias for a capped internal test before enabling more providers.
- Verify actual provider connectivity and usage/cost reporting before declaring a provider connected.

### Gate E — release verification

- Run typecheck, unit tests and integration tests on this branch.
- Run an end-to-end Preview test using a synthetic project and synthetic payment records only.
- Verify the validated Love Ways quote/invoice/payment/launch records remain unchanged.
- Verify duplicate launch/handoff requests do not create duplicate jobs.
- Verify unauthenticated, non-admin, missing-consent, mismatched-digest and insufficient-budget requests are rejected.
- Verify no production deployment or external side effect occurs without explicit approval.

## Current verified limitations

- The two feature branches are divergent; they must not be merged wholesale.
- The official launch endpoint and factory job endpoint are separate today.
- The factory job endpoint currently records `executionMode: "manual_worker_required"` and does not execute tasks.
- No durable worker has been verified.
- No persistent provider-credential repository or OAuth callback has been verified.
- No production AI provider call has been verified.
- This branch has not yet passed build, typecheck, tests or Preview E2E.

## Safety status

No Supabase schema or customer data was changed to create this branch. No Vercel deployment was triggered. Production was not modified.


## Read-only database relationship check (2026-10-31)

Supabase schema and existing records were inspected read-only after this branch was created.

- `client_requests.project_id` is text and identifies the project slug used by the commercial request.
- `user_projects.id` is also text and is the foreign-key target for factory plans, approvals and jobs.
- A join on both `client_requests.project_id = user_projects.id` and `client_requests.user_id = user_projects.user_id` matched **Student Vision** exactly.
- The same join did **not** match **Love Ways**. Its commercial request and official launch exist, but no corresponding `user_projects` row exists for that owner/project key.
- Both existing launch rows remain untouched. No project row, plan, approval, factory job or task was inserted.

### Consequence

A launch-to-factory handoff can be safely associated by the exact `project_id` + owner pair only when that matching `user_projects` record exists. Do not create a replacement project silently for Love Ways, do not match by title alone, and do not use the client's email as an ownership key.

Before Love Ways can enter the factory, the product needs an explicit admin-reviewed reconciliation action that either:
1. links its existing request to an already-existing owner-matched `user_projects` record; or
2. creates a new `user_projects` record through the normal project-creation flow and stores a durable association to the existing request.

The second option is a data mutation and must be separately reviewed, must preserve the original request/quote/invoice/payment/launch records, and must not duplicate the commercial project.

Student Vision has a relational match, but factory execution still remains blocked until its exact plan, three approvals and AI-processing consent exist. The current database inspection showed zero factory jobs and zero approval rows at the time of the read.

## Additional security and schema audit (read-only, 2026-10-31)

A direct source review of the commercial branch and a read-only inspection of the live Supabase catalog found the following:

### Schema facts

- `client_project_launches.request_id` has a foreign key to `client_requests.id` and a unique constraint, so one official launch is allowed per commercial request.
- `client_requests.project_id` and `user_projects.id` are both text columns, but the catalog inspection did not show a foreign key between them. Their relationship is currently an application-level convention, not a database-enforced relation.
- `project_memory_plan_versions.project_id` references `user_projects.id`.
- `project_memory_approvals.project_id` references `user_projects.id` and approvals carry a non-null `ai_processing_consent` boolean.
- `project_factory_jobs` stores project, plan version/digests, approval IDs and correlation ID. It has no persisted commercial `launch_id` association in its current column set.
- The existing factory endpoint performs separate REST inserts for the job and tasks. A task insert failure can therefore leave a job without its full task set.

### Consent enforcement gap

The commercial branch factory-job route fetches approval rows and checks the exact approval kinds, decision, plan digest and scope digest. It does not select or explicitly require `ai_processing_consent = true` on the client-scope approval.

More importantly, the live `project_factory_jobs` INSERT RLS policy also checks the three approval kinds and matching plan digests, but its predicate does not check `ai_processing_consent`. The approval table contains the consent field, but its existence alone is not enforcement.

**Required fix before any factory job can be created:** enforce explicit, current client AI-processing consent at both the server route and the database INSERT boundary. The consent must be tied to the same project, plan version, plan digest and scope digest as the job. A route-only check is insufficient because an authenticated admin token can call the Supabase Data API directly.

No policy or schema change was applied during this audit.

### Launch-to-project gap

The commercial launch route verifies the invoice, published and accepted quote version, confirmed payments and duplicate launch. It does not verify that the request has an owner-matched `user_projects` row before recording the launch. This is why an official commercial launch can exist without a factory-addressable project, as observed for Love Ways.

Do not silently add this check to the existing launch route until its product impact is reviewed: it could block future legitimate commercial launches. Instead, add an explicit admin-reviewed reconciliation and factory-readiness step that preserves the already validated launch flow.

### Immediate implementation blockers

1. Consent must be enforced at both API and database boundaries.
2. Launch-to-project mapping needs a durable, admin-reviewed association.
3. Job and task creation must become atomic (or use a tested durable outbox).
4. A stable unique launch-to-job handoff key and persisted launch association are needed before automatic handoff.
5. No worker may claim jobs until atomic leases, consent revalidation, cancellation, retry limits and budget checks exist.

This was a read-only audit. No customer data, RLS policy, schema, deployment or production code was changed.
## Implementation progress — 2026-10-31

### Implemented on the reconciliation branch (source changes only)

- The factory-job API now selects `ai_processing_consent` and refuses creation unless the exact approved `client_scope` row for the same project, plan version, plan digest and scope digest explicitly has consent set to `true`.
- Added a regression test for missing client AI-processing consent.
- Added migration `supabase/migrations/20261031100000_enforce_factory_ai_processing_consent.sql`. It updates the factory-job INSERT RLS policy so a direct authenticated Supabase Data API insert must also have an exact approved client-scope row with `ai_processing_consent = true`.
- The same migration adds `public.create_factory_job_with_tasks(jsonb,jsonb)`, a `SECURITY INVOKER` RPC. It inserts the job and all task rows in one PostgreSQL transaction; existing RLS policies still govern both inserts. It is executable by `authenticated`, not `anon` or `public`.
- The API now calls this RPC once instead of making two separate inserts. The existing unique `(project_id, correlation_id)` index remains the final duplicate-race guard.
- The factory API response still explicitly states `executionStarted: false`; no model invocation, repository write or deployment is started.

### Source verification

- Re-fetched the API route, regression test and migration from this branch after commits. Verified that the route uses the atomic RPC, checks explicit consent, the test covers missing consent, and the migration contains both the RLS consent guard and atomic function.
- Live Supabase catalog was inspected read-only to confirm the required columns, existing unique correlation index, task uniqueness constraint and composite job/task project relationship before authoring the RPC.
- No tests, typecheck or build have been executed in a local checkout during this session. GitHub source re-fetch is not a substitute for runtime verification.
- The migration has **not** been applied to the connected Supabase project. Until it is applied and verified, the live database RLS policy remains unchanged and the direct-API consent bypass remains open on that database.
- No Vercel deployment was triggered. Production remains untouched.

### Remaining blockers

1. Apply and verify the migration in the intended Supabase environment after review; do not assume the GitHub migration file has changed the live database.
2. Run `npm ci`, `npm run typecheck`, `npm test` and `npm run build` on this branch; fix any failures.
3. Add a safe, admin-reviewed association for commercial requests that lack an owner-matched `user_projects` row. Do not auto-create or guess the Love Ways mapping.
4. Implement launch-to-job idempotent handoff only after the association and exact plan/approval/consent checks are available.
5. Implement a durable worker with atomic leases, retries, cancellation, budgets, audit evidence and a separate human delivery/deployment authorization.

These changes are committed to the isolated feature branch only. They are not a live database or production release.