import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAdminAccess } from "@/lib/server/admin-access";
import { callUserData, getAccessToken, getCurrentUser, isSameOrigin } from "@/lib/server/supabase-rest";

export const dynamic = "force-dynamic";

type LaunchBody = { planVersion: number; correlationId: string };
const REQUIRED_APPROVALS = ["client_scope", "admin_review", "execution_authorization"] as const;
const TASKS = [
  { task_key: "prepare_specification", state: "not_started", dependencies: [], evidence_required: true, external_side_effect: false, result_is_known: true },
  { task_key: "generate_application", state: "not_started", dependencies: ["prepare_specification"], evidence_required: true, external_side_effect: false, result_is_known: true },
  { task_key: "run_quality_checks", state: "not_started", dependencies: ["generate_application"], evidence_required: true, external_side_effect: false, result_is_known: true },
  { task_key: "repair_and_retest", state: "not_started", dependencies: ["run_quality_checks"], evidence_required: true, external_side_effect: false, result_is_known: true },
  { task_key: "human_delivery_review", state: "not_started", dependencies: ["repair_and_retest"], evidence_required: true, external_side_effect: true, result_is_known: true },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function validBody(value: unknown): value is LaunchBody {
  return isRecord(value) && Number.isSafeInteger(value.planVersion) && Number(value.planVersion) > 0 &&
    typeof value.correlationId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.correlationId);
}

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Requête non autorisée." }, { status: 403 });
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Données invalides." }, { status: 400 }); }
  if (!validBody(body)) return NextResponse.json({ error: "Les paramètres de lancement sont invalides." }, { status: 400 });

  try {
    const store = await cookies();
    const [user, token, admin] = await Promise.all([
      getCurrentUser(store), getAccessToken(store), getAdminAccess(),
    ]);
    if (!user || !token) return NextResponse.json({ error: "Connexion administrateur requise." }, { status: 401 });
    if (!admin.ok) return NextResponse.json({ error: "Accès administrateur refusé." }, { status: 403 });

    const { projectId } = await context.params;
    if (typeof projectId !== "string" || projectId.length < 3 || projectId.length > 100) {
      return NextResponse.json({ error: "Projet introuvable." }, { status: 404 });
    }

    const planResult = await callUserData(
      `project_memory_plan_versions?select=version,payload,payload_digest,scope_digest,source_brief_version&project_id=eq.${encodeURIComponent(projectId)}&version=eq.${body.planVersion}&limit=1`,
      "GET", token,
    );
    if (!planResult.ok) return NextResponse.json({ error: "Impossible de vérifier le plan." }, { status: 502 });
    const plan = Array.isArray(planResult.data) ? planResult.data[0] : null;
    if (!isRecord(plan) || plan.version !== body.planVersion ||
      typeof plan.payload_digest !== "string" || typeof plan.scope_digest !== "string" ||
      !isRecord(plan.payload)) {
      return NextResponse.json({ error: "Version de plan introuvable ou invalide." }, { status: 404 });
    }

    const approvalResult = await callUserData(
      `project_memory_approvals?select=id,approval_kind,decision,plan_digest,scope_digest,ai_processing_consent&project_id=eq.${encodeURIComponent(projectId)}&plan_version=eq.${body.planVersion}`,
      "GET", token,
    );
    if (!approvalResult.ok) return NextResponse.json({ error: "Impossible de vérifier les validations." }, { status: 502 });
    const approvals = Array.isArray(approvalResult.data) ? approvalResult.data : [];
    const exactApprovalRows = approvals.filter((item) => isRecord(item) &&
      typeof item.id === "string" && item.decision === "approved" &&
      item.plan_digest === plan.payload_digest && item.scope_digest === plan.scope_digest);
    const exactApproved = new Set(exactApprovalRows.map((item) => item.approval_kind));
    const missing = REQUIRED_APPROVALS.filter((kind) => !exactApproved.has(kind));
    const hasExplicitAiConsent = exactApprovalRows.some((item) =>
      item.approval_kind === "client_scope" && item.ai_processing_consent === true);
    if (missing.length || !hasExplicitAiConsent) {
      return NextResponse.json({ error: "Le lancement est bloqué : les trois validations exactes sont obligatoires.", missingApprovals: missing, ...(hasExplicitAiConsent ? {} : { missingConsent: "client_scope" }) }, { status: 409 });
    }

    const existing = await callUserData(
      `project_factory_jobs?select=id,status&project_id=eq.${encodeURIComponent(projectId)}&correlation_id=eq.${body.correlationId}&limit=1`,
      "GET", token,
    );
    if (!existing.ok) return NextResponse.json({ error: "Impossible de vérifier une demande précédente." }, { status: 502 });
    if (Array.isArray(existing.data) && existing.data.length) {
      return NextResponse.json({ error: "Cette demande de lancement existe déjà." }, { status: 409 });
    }

    const jobResult = await callUserData("project_factory_jobs", "POST", token, {
      project_id: projectId, plan_version: body.planVersion,
      plan_digest: plan.payload_digest, scope_digest: plan.scope_digest,
      status: "queued", manifest: {
        schemaVersion: 1, kind: "merkora_project_factory_job",
        projectId, planVersion: body.planVersion,
        sourceBriefVersion: plan.source_brief_version,
        approvalIds: exactApprovalRows.map((approval) => approval.id),
        stages: TASKS.map((task) => task.task_key),
        executionMode: "manual_worker_required",
        deliveryRequiresHumanReview: true,
      },
      requested_by: user.id, authorized_by: user.id,
      approval_ids: exactApprovalRows.map((approval) => approval.id), correlation_id: body.correlationId,
    }, "return=representation");
    if (!jobResult.ok) return NextResponse.json(
      { error: jobResult.status === 409 ? "Un travail existe déjà pour cet identifiant de corrélation." : "La base a refusé la création du travail. Vérifiez les trois validations et réessayez." },
      { status: jobResult.status === 403 ? 403 : jobResult.status === 409 ? 409 : 502 },
    );
    const job = Array.isArray(jobResult.data) ? jobResult.data[0] : null;
    if (!isRecord(job) || typeof job.id !== "string") {
      return NextResponse.json({ error: "Le travail a été créé, mais son identifiant n'a pas été retourné. Vérification administrateur nécessaire." }, { status: 502 });
    }

    const taskResult = await callUserData("project_factory_tasks", "POST", token,
      TASKS.map((task) => ({ ...task, job_id: job.id, project_id: projectId })),
      "return=representation",
    );
    if (!taskResult.ok) {
      return NextResponse.json({ error: "Le travail est créé, mais ses étapes initiales n'ont pas toutes été enregistrées. Ne relancez pas : une réconciliation administrateur est nécessaire.", jobId: job.id }, { status: 502 });
    }

    return NextResponse.json({
      created: true, jobId: job.id, status: "queued",
      taskCount: TASKS.length, executionStarted: false,
      message: "Le travail est préparé. Aucun agent ni déploiement n'a été lancé.",
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const notConfigured = error instanceof Error && error.message === "SUPABASE_NOT_CONFIGURED";
    return NextResponse.json({ error: notConfigured ? "Le service n'est pas configuré." : "Le service de fabrication est momentanément indisponible." }, {
      status: notConfigured ? 503 : 502, headers: { "Cache-Control": "no-store" },
    });
  }
}
