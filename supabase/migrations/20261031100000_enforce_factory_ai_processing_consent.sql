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


-- Create the job and its complete task set in one database transaction.
-- SECURITY INVOKER is intentional: table RLS policies remain in force for both inserts.
create or replace function public.create_factory_job_with_tasks(
  p_job jsonb,
  p_tasks jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_job_id uuid;
  v_project_id text;
  v_task_count integer;
begin
  if jsonb_typeof(p_job) is distinct from 'object' then
    raise exception 'invalid_factory_job_payload' using errcode = '22023';
  end if;
  if jsonb_typeof(p_tasks) is distinct from 'array' then
    raise exception 'invalid_factory_task_payload' using errcode = '22023';
  end if;
  if jsonb_array_length(p_tasks) < 1 or jsonb_array_length(p_tasks) > 20 then
    raise exception 'invalid_factory_task_count' using errcode = '22023';
  end if;

  v_project_id := p_job ->> 'project_id';
  if v_project_id is null or length(v_project_id) < 3 or length(v_project_id) > 100 then
    raise exception 'invalid_factory_project_id' using errcode = '22023';
  end if;

  insert into public.project_factory_jobs (
    project_id, plan_version, plan_digest, scope_digest, status, manifest,
    requested_by, authorized_by, approval_ids, correlation_id
  ) values (
    v_project_id,
    (p_job ->> 'plan_version')::integer,
    p_job ->> 'plan_digest',
    p_job ->> 'scope_digest',
    coalesce(p_job ->> 'status', 'queued'),
    p_job -> 'manifest',
    (p_job ->> 'requested_by')::uuid,
    (p_job ->> 'authorized_by')::uuid,
    array(select jsonb_array_elements_text(coalesce(p_job -> 'approval_ids', '[]'::jsonb))::uuid),
    (p_job ->> 'correlation_id')::uuid
  )
  returning id into v_job_id;

  insert into public.project_factory_tasks (
    job_id, project_id, task_key, state, dependencies,
    evidence_required, external_side_effect, result_is_known
  )
  select
    v_job_id, v_project_id, t.task_key,
    coalesce(t.state, 'not_started'),
    coalesce(t.dependencies, '[]'::jsonb),
    coalesce(t.evidence_required, false),
    coalesce(t.external_side_effect, false),
    coalesce(t.result_is_known, true)
  from jsonb_to_recordset(p_tasks) as t(
    task_key text,
    state text,
    dependencies jsonb,
    evidence_required boolean,
    external_side_effect boolean,
    result_is_known boolean
  );

  get diagnostics v_task_count = row_count;
  if v_task_count <> jsonb_array_length(p_tasks) then
    raise exception 'factory_task_count_mismatch' using errcode = '22000';
  end if;

  return jsonb_build_object('job_id', v_job_id, 'task_count', v_task_count);
end;
$$;

revoke all on function public.create_factory_job_with_tasks(jsonb, jsonb) from public;
revoke all on function public.create_factory_job_with_tasks(jsonb, jsonb) from anon;
grant execute on function public.create_factory_job_with_tasks(jsonb, jsonb) to authenticated;

comment on function public.create_factory_job_with_tasks(jsonb, jsonb) is
  'Atomically inserts a factory job and its tasks under caller RLS policies; no execution is started.';
