-- Enforce explicit client AI-processing consent at the database boundary.
-- This preserves the existing admin, requester, plan-digest and three-approval checks.
-- Existing approval rows default to false and cannot be retroactively treated as consent.

drop policy if exists "admins can create factory jobs after exact approvals"
  on public.project_factory_jobs;

create policy "admins can create factory jobs after exact approvals"
on public.project_factory_jobs
for insert
to authenticated
with check (
  is_merkora_admin()
  and requested_by = (select auth.uid())
  and authorized_by = (select auth.uid())
  and exists (
    select 1 from public.project_memory_plan_versions v
    where v.project_id = project_factory_jobs.project_id
      and v.version = project_factory_jobs.plan_version
      and v.payload_digest = project_factory_jobs.plan_digest
      and v.scope_digest = project_factory_jobs.scope_digest
  )
  and exists (
    select 1 from public.project_memory_approvals a
    where a.project_id = project_factory_jobs.project_id
      and a.plan_version = project_factory_jobs.plan_version
      and a.plan_digest = project_factory_jobs.plan_digest
      and a.scope_digest = project_factory_jobs.scope_digest
      and a.approval_kind = 'client_scope'
      and a.decision = 'approved'
      and a.ai_processing_consent is true
  )
  and exists (
    select 1 from public.project_memory_approvals a
    where a.project_id = project_factory_jobs.project_id
      and a.plan_version = project_factory_jobs.plan_version
      and a.plan_digest = project_factory_jobs.plan_digest
      and a.scope_digest = project_factory_jobs.scope_digest
      and a.approval_kind = 'admin_review'
      and a.decision = 'approved'
  )
  and exists (
    select 1 from public.project_memory_approvals a
    where a.project_id = project_factory_jobs.project_id
      and a.plan_version = project_factory_jobs.plan_version
      and a.plan_digest = project_factory_jobs.plan_digest
      and a.scope_digest = project_factory_jobs.scope_digest
      and a.approval_kind = 'execution_authorization'
      and a.decision = 'approved'
  )
);

comment on policy "admins can create factory jobs after exact approvals"
on public.project_factory_jobs is
  'Requires admin identity, exact plan digests, all three approvals, and explicit client AI-processing consent on the matching client_scope approval.';
