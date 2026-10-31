import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createProjectMemoryDigest } from "@/lib/factory/project-memory-digest";
import { evaluateCommercialLaunchEligibility } from "@/lib/factory/commercial-launch-eligibility";
import { createProjectArchive } from "@/lib/factory/project-archive";
import { generateProjectSource } from "@/lib/factory/project-generator";
import { createVercelProjectSandbox } from "@/lib/factory/vercel-project-sandbox";
import { runProjectBuildInSandbox } from "@/lib/factory/project-sandbox-runner";
import { getAdminAccess } from "@/lib/server/admin-access";
import {
  callUserData, getAccessToken, getCurrentUser, isSameOrigin, uploadUserStorageObject,
} from "@/lib/server/supabase-rest";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BUCKET = "merkora-factory-artifacts";
const REQUIRED_APPROVALS = ["client_scope", "admin_review", "execution_authorization"] as const;
const REQUIRED_TASKS = [
  "prepare_specification", "generate_application", "run_quality_checks",
  "repair_and_retest", "human_delivery_review",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function safeProjectId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{3,100}$/.test(value);
}
function slug(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
}
function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}
function safeLog(value: string): string {
  return value.slice(-12_000);
}

async function patchJob(projectId: string, jobId: string, token: string, body: Record<string, unknown>) {
  return callUserData(
    `project_factory_jobs?id=eq.${encodeURIComponent(jobId)}&project_id=eq.${encodeURIComponent(projectId)}`,
    "PATCH", token, body, "return=representation",
  );
}

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string; jobId: string }> },
) {
  let claimedContext: { projectId: string; jobId: string; token: string; manifest: Record<string, unknown> } | null = null;
  let finalized = false;
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Requête non autorisée." }, { status: 403 });
  }

  try {
    const store = await cookies();
    const [user, token, admin] = await Promise.all([
      getCurrentUser(store), getAccessToken(store), getAdminAccess(),
    ]);
    if (!user || !token) return NextResponse.json({ error: "Connexion administrateur requise." }, { status: 401 });
    if (!admin.ok) return NextResponse.json({ error: "Accès administrateur refusé." }, { status: 403 });

    const { projectId, jobId } = await context.params;
    if (!safeProjectId(projectId) || !isUuid(jobId)) {
      return NextResponse.json({ error: "Projet ou travail introuvable." }, { status: 404 });
    }

    const jobResult = await callUserData(
      `project_factory_jobs?select=id,status,plan_version,plan_digest,scope_digest,approval_ids,correlation_id,manifest&project_id=eq.${encodeURIComponent(projectId)}&id=eq.${encodeURIComponent(jobId)}&limit=1`,
      "GET", token,
    );
    if (!jobResult.ok) return NextResponse.json({ error: "Lecture du travail impossible." }, { status: 502 });
    const job = rows(jobResult.data)[0];
    if (!job || job.status !== "queued" || !Number.isSafeInteger(job.plan_version) ||
      typeof job.plan_digest !== "string" || typeof job.scope_digest !== "string" ||
      !Array.isArray(job.approval_ids) || !isRecord(job.manifest)) {
      return NextResponse.json({ error: "Le travail n'est pas en attente ou son manifeste est invalide." }, { status: 409 });
    }

    const planResult = await callUserData(
      `project_memory_plan_versions?select=version,payload,payload_digest,scope_digest,source_brief_version&project_id=eq.${encodeURIComponent(projectId)}&version=eq.${job.plan_version}&limit=1`,
      "GET", token,
    );
    if (!planResult.ok) return NextResponse.json({ error: "Lecture du plan approuvé impossible." }, { status: 502 });
    const plan = rows(planResult.data)[0];
    if (!plan || !isRecord(plan.payload) || !Array.isArray(plan.payload.includedScope) ||
      createProjectMemoryDigest(plan.payload) !== job.plan_digest ||
      plan.payload_digest !== job.plan_digest ||
      createProjectMemoryDigest(plan.payload.includedScope) !== job.scope_digest ||
      plan.scope_digest !== job.scope_digest) {
      return NextResponse.json({ error: "Le plan a changé ou ne correspond plus aux empreintes approuvées." }, { status: 409 });
    }

    const approvalResult = await callUserData(
      `project_memory_approvals?select=id,approval_kind,decision,plan_digest,scope_digest,ai_processing_consent&project_id=eq.${encodeURIComponent(projectId)}&plan_version=eq.${job.plan_version}`,
      "GET", token,
    );
    if (!approvalResult.ok) return NextResponse.json({ error: "Vérification des validations impossible." }, { status: 502 });
    const approvalRows = rows(approvalResult.data).filter((approval) =>
      approval.decision === "approved" && approval.plan_digest === job.plan_digest &&
      approval.scope_digest === job.scope_digest && typeof approval.id === "string");
    const approvalIds = new Set(job.approval_ids.filter((id): id is string => typeof id === "string"));
    const missing = REQUIRED_APPROVALS.filter((kind) =>
      !approvalRows.some((approval) => approval.approval_kind === kind && approvalIds.has(String(approval.id))));
    const hasClientAiConsent = approvalRows.some((approval) =>
      approval.approval_kind === "client_scope" &&
      approvalIds.has(String(approval.id)) &&
      approval.ai_processing_consent === true);
    if (missing.length || !hasClientAiConsent) {
      return NextResponse.json({
        error: "La fabrication exige les trois validations exactes et le consentement IA explicite du client.",
        missingApprovals: missing,
        missingConsent: hasClientAiConsent ? undefined : "client_scope",
      }, { status: 409 });
    }

    const projectResult = await callUserData(
      `user_projects?select=id,user_id,title,problem,desired_outcome&id=eq.${encodeURIComponent(projectId)}&limit=1`,
      "GET", token,
    );
    if (!projectResult.ok) return NextResponse.json({ error: "Lecture du projet impossible." }, { status: 502 });
    const project = rows(projectResult.data)[0];
    if (!project || typeof project.user_id !== "string" ||
      typeof project.title !== "string" || typeof project.problem !== "string" ||
      typeof project.desired_outcome !== "string") {
      return NextResponse.json({ error: "Le dossier client est incomplet ou sans propriétaire vérifiable." }, { status: 409 });
    }

    // Commercial authorization is re-checked immediately before claiming a worker slot.
    // Never infer the request/project relationship from title or email.
    const requestResult = await callUserData(
      `client_requests?select=id,user_id,project_id&project_id=eq.${encodeURIComponent(projectId)}&user_id=eq.${encodeURIComponent(project.user_id)}`,
      "GET", token,
    );
    if (!requestResult.ok) return NextResponse.json({ error: "Vérification de la demande commerciale impossible." }, { status: 502 });
    const commercialRequests = rows(requestResult.data);
    const requestIds = commercialRequests
      .map((item) => item.id)
      .filter((id): id is string => isUuid(id));
    const launchResult = requestIds.length
      ? await callUserData(
          `client_project_launches?select=request_id,client_user_id,required_amount,confirmed_amount_at_launch&request_id=in.(${requestIds.join(",")})`,
          "GET", token,
        )
      : { ok: true, data: [] };
    if (!launchResult.ok) return NextResponse.json({ error: "Vérification du lancement et du paiement impossible." }, { status: 502 });

    const launchEligibility = evaluateCommercialLaunchEligibility({
      projectId,
      projectOwnerId: project.user_id,
      requests: commercialRequests.map((item) => ({
        id: item.id, projectId: item.project_id, userId: item.user_id,
      })),
      launches: rows(launchResult.data).map((item) => ({
        requestId: item.request_id,
        clientUserId: item.client_user_id,
        requiredAmount: item.required_amount,
        confirmedAmountAtLaunch: item.confirmed_amount_at_launch,
      })),
    });
    if (!launchEligibility.ok) {
      const messages: Record<typeof launchEligibility.reason, string> = {
        invalid_project_owner: "Le propriétaire du projet ne peut pas être vérifié.",
        request_not_found: "Aucune demande commerciale liée au propriétaire exact de ce projet. Une réconciliation administrateur est nécessaire.",
        launch_not_found: "La demande n'a pas encore de lancement commercial officiel.",
        owner_mismatch: "Le lancement commercial appartient à un autre compte client.",
        invalid_launch_record: "Les données du lancement commercial sont incomplètes ou invalides.",
        insufficient_confirmed_payment: "Le seuil d'acompte confirmé enregistré au lancement n'est pas atteint.",
      };
      return NextResponse.json({
        error: messages[launchEligibility.reason],
        code: "COMMERCIAL_LAUNCH_NOT_ELIGIBLE",
        reason: launchEligibility.reason,
      }, { status: 409 });
    }

    const taskResult = await callUserData(
      `project_factory_tasks?select=id,task_key,state,external_side_effect&project_id=eq.${encodeURIComponent(projectId)}&job_id=eq.${encodeURIComponent(jobId)}`,
      "GET", token,
    );
    if (!taskResult.ok) return NextResponse.json({ error: "Lecture des étapes impossible." }, { status: 502 });
    const taskRows = rows(taskResult.data);
    const taskByKey = new Map(taskRows.map((task) => [task.task_key, task]));
    if (REQUIRED_TASKS.some((key) => !taskByKey.has(key)) ||
      taskRows.length !== REQUIRED_TASKS.length ||
      taskRows.some((task) => task.state !== "not_started") ||
      taskByKey.get("human_delivery_review")?.external_side_effect !== true) {
      return NextResponse.json({ error: "Les étapes du travail ne sont pas dans leur état initial attendu." }, { status: 409 });
    }

    // Compare-and-set: only one request can move this job from queued to building.
    const claim = await callUserData(
      `project_factory_jobs?id=eq.${encodeURIComponent(jobId)}&project_id=eq.${encodeURIComponent(projectId)}&status=eq.queued`,
      "PATCH", token, { status: "building", updated_at: new Date().toISOString() }, "return=representation",
    );
    if (!claim.ok) return NextResponse.json({ error: "Impossible de réserver ce travail." }, { status: 502 });
    if (rows(claim.data).length !== 1) {
      return NextResponse.json({ error: "Ce travail a déjà été pris en charge par une autre exécution." }, { status: 409 });
    }
    claimedContext = { projectId, jobId, token, manifest: job.manifest };

    const modules = plan.payload.includedScope.map((item) => {
      if (!isRecord(item) || typeof item.id !== "string" ||
        typeof item.title !== "string" || typeof item.description !== "string") return null;
      return {
        id: slug(item.id) || slug(item.title),
        title: item.title,
        description: item.description.trim() || item.title,
      };
    });
    if (modules.some((item) => item === null)) {
      await patchJob(projectId, jobId, token, { status: "blocked", updated_at: new Date().toISOString() });
      return NextResponse.json({ error: "Le périmètre approuvé contient un module invalide." }, { status: 422 });
    }

    const source = generateProjectSource({
      projectName: project.title,
      projectDescription: `${project.problem} Objectif : ${project.desired_outcome}`.slice(0, 500),
      modules: modules as Array<{ id: string; title: string; description: string }>,
    });
    const archive = createProjectArchive(source);
    const sourceManifestPath = `${projectId}/${jobId}/source-${source.digest}.json`;
    const sourcePath = `${projectId}/${jobId}/source-${source.digest}.tar.gz`;
    const sourceUpload = await uploadUserStorageObject(
      BUCKET, sourceManifestPath, JSON.stringify(source), token,
    );
    if (!sourceUpload.ok) {
      await patchJob(projectId, jobId, token, {
        status: "failed", updated_at: new Date().toISOString(),
        manifest: { ...job.manifest, failureStage: "artifact_manifest_upload", sourceDigest: source.digest },
      });
      return NextResponse.json({ error: "Le manifeste du code généré n'a pas pu être conservé dans le stockage privé.", stage: "artifact_manifest_upload" }, { status: 502 });
    }
    const archiveUpload = await uploadUserStorageObject(
      BUCKET, sourcePath, archive.bytes, token, archive.contentType,
    );
    if (!archiveUpload.ok) {
      await patchJob(projectId, jobId, token, {
        status: "failed", updated_at: new Date().toISOString(),
        manifest: { ...job.manifest, sourceManifestPath, sourceDigest: source.digest, failureStage: "source_archive_upload" },
      });
      return NextResponse.json({ error: "L'archive téléchargeable du projet n'a pas pu être conservée.", stage: "source_archive_upload" }, { status: 502 });
    }

    const build = await runProjectBuildInSandbox(source, createVercelProjectSandbox);
    const report = {
      schemaVersion: 1, projectId, jobId, planVersion: job.plan_version,
      sourceDigest: source.digest, generatorVersion: source.generatorVersion,
      moduleIds: source.moduleIds, fileCount: source.files.length,
      result: build.ok ? "passed" : "failed",
      stage: build.stage,
      reason: build.ok ? null : build.reason,
      logs: safeLog(build.logs),
      generatedAt: new Date().toISOString(),
      delivery: "not_deployed_human_review_required",
      implementationLevel: "scaffold",
    };
    const reportDigest = createProjectMemoryDigest(report);
    const reportPath = `${projectId}/${jobId}/build-report-${reportDigest}.json`;
    const reportUpload = await uploadUserStorageObject(BUCKET, reportPath, JSON.stringify(report), token);
    if (!reportUpload.ok) {
      await patchJob(projectId, jobId, token, {
        status: "failed", updated_at: new Date().toISOString(),
        manifest: { ...job.manifest, sourcePath, sourceManifestPath, sourceDigest: source.digest, failureStage: "report_upload" },
      });
      return NextResponse.json({ error: "Le code est conservé, mais le rapport de compilation n'a pas pu être enregistré.", stage: "report_upload" }, { status: 502 });
    }

    const evidencePayload: Array<Record<string, unknown>> = [
      {
        job_id: jobId, project_id: projectId, task_id: taskByKey.get("prepare_specification")?.id,
        evidence_type: "other", storage_path: `database://project_memory_plan_versions/${projectId}/${job.plan_version}`,
        content_digest: job.plan_digest, metadata: { planVersion: job.plan_version, scopeDigest: job.scope_digest },
        created_by: user.id,
      },
      {
        job_id: jobId, project_id: projectId, task_id: taskByKey.get("generate_application")?.id,
        evidence_type: "artifact", storage_path: `storage://${BUCKET}/${sourcePath}`,
        content_digest: source.digest, metadata: { generatorVersion: source.generatorVersion, fileCount: source.files.length, moduleIds: source.moduleIds, sourceManifestPath },
        created_by: user.id,
      },
      {
        job_id: jobId, project_id: projectId, task_id: taskByKey.get("run_quality_checks")?.id,
        evidence_type: "test_result", storage_path: `storage://${BUCKET}/${reportPath}`,
        content_digest: reportDigest, metadata: { stage: build.stage, result: build.ok ? "passed" : "failed" },
        created_by: user.id,
      },
    ];
    if (build.ok) {
      evidencePayload.push({
        job_id: jobId, project_id: projectId, task_id: taskByKey.get("repair_and_retest")?.id,
        evidence_type: "review", storage_path: `storage://${BUCKET}/${reportPath}`,
        content_digest: reportDigest, metadata: { repairRequired: false, retestPassed: true },
        created_by: user.id,
      });
    }
    const evidenceResult = await callUserData("project_factory_evidence", "POST", token, evidencePayload, "return=representation");
    if (!evidenceResult.ok || rows(evidenceResult.data).length !== evidencePayload.length) {
      await patchJob(projectId, jobId, token, {
        status: "failed", updated_at: new Date().toISOString(),
        manifest: { ...job.manifest, sourcePath, sourceManifestPath, reportPath, sourceDigest: source.digest, reportDigest, failureStage: "evidence_persistence" },
      });
      return NextResponse.json({ error: "Les artefacts sont stockés, mais leurs preuves n'ont pas toutes été enregistrées.", stage: "evidence_persistence" }, { status: 502 });
    }

    const stateUpdates = build.ok
      ? REQUIRED_TASKS.map((key) => ({
          key, state: key === "human_delivery_review" ? "ready" : "completed",
        }))
      : [
          { key: "prepare_specification", state: "completed" },
          { key: "generate_application", state: "completed" },
          { key: "run_quality_checks", state: "failed" },
          { key: "repair_and_retest", state: "blocked" },
          { key: "human_delivery_review", state: "blocked" },
        ];
    for (const update of stateUpdates) {
      const task = taskByKey.get(update.key);
      const result = await callUserData(
        `project_factory_tasks?id=eq.${encodeURIComponent(String(task?.id))}&job_id=eq.${encodeURIComponent(jobId)}`,
        "PATCH", token, { state: update.state, updated_at: new Date().toISOString() }, "return=representation",
      );
      if (!result.ok) {
        await patchJob(projectId, jobId, token, { status: "failed", updated_at: new Date().toISOString() });
        return NextResponse.json({ error: "Les preuves sont enregistrées, mais une étape n'a pas pu être mise à jour. Réconciliation administrateur requise." }, { status: 502 });
      }
    }

    const finalStatus = build.ok ? "awaiting_approval" : "failed";
    const manifest = {
      ...job.manifest,
      sourcePath, sourceManifestPath, reportPath, sourceDigest: source.digest, reportDigest,
      generatorVersion: source.generatorVersion, generatedFileCount: source.files.length,
      generatedModuleIds: source.moduleIds, buildResult: build.ok ? "passed" : "failed",
      buildStage: build.stage, buildLogs: safeLog(build.logs),
      implementationLevel: "scaffold",
      fullBusinessLogicImplementationPending: true,
      deployment: "not_started",
      deliveryRequiresHumanReview: true,
    };
    const finalJob = await patchJob(projectId, jobId, token, {
      status: finalStatus, manifest, updated_at: new Date().toISOString(),
    });
    if (!finalJob.ok) {
      return NextResponse.json({ error: "Les artefacts sont enregistrés, mais le statut final du travail doit être réconcilié.", jobId }, { status: 502 });
    }
    finalized = true;

    const event = await callUserData("project_memory_events", "POST", token, {
      project_id: projectId, event_type: build.ok ? "evidence_recorded" : "task_failed",
      actor_user_id: user.id, actor_role: "admin",
      correlation_id: job.correlation_id, plan_version: job.plan_version,
      task_key: build.ok ? "human_delivery_review" : "run_quality_checks",
      summary: build.ok
        ? "Le squelette applicatif a été généré et compilé ; la logique métier complète et la livraison restent en attente."
        : "La compilation du squelette applicatif a échoué ; les journaux et artefacts sont conservés pour correction.",
      payload: { sourceDigest: source.digest, reportDigest, buildStage: build.stage, evidenceIds: rows(evidenceResult.data).map((item) => item.id) },
    }, "return=minimal");
    if (!event.ok) {
      return NextResponse.json({ error: "Le travail a été mis à jour, mais son événement d'audit doit être réconcilié.", jobId }, { status: 502 });
    }

    return NextResponse.json({
      created: true, jobId, status: finalStatus,
      executionStarted: true, buildPassed: build.ok,
      deployed: false, humanReviewRequired: true,
      implementationLevel: "scaffold",
      fullBusinessLogicImplementationPending: true,
      fileCount: source.files.length, moduleCount: source.moduleIds.length,
      sourceDigest: source.digest, reportDigest,
      message: build.ok
        ? "Le squelette applicatif a été généré, compilé et archivé. La logique métier complète reste à développer avant livraison."
        : "Le code a été généré et archivé, mais la compilation a échoué. Le travail est bloqué pour correction.",
    }, { status: build.ok ? 200 : 422, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (claimedContext && !finalized) {
      try {
        await patchJob(claimedContext.projectId, claimedContext.jobId, claimedContext.token, {
          status: "failed",
          manifest: { ...claimedContext.manifest, failureStage: "unexpected_worker_error" },
          updated_at: new Date().toISOString(),
        });
      } catch { /* the job remains visible for administrator reconciliation */ }
    }
    const missingConfig = error instanceof Error && error.message === "SUPABASE_NOT_CONFIGURED";
    return NextResponse.json({
      error: missingConfig ? "Le service n'est pas configuré." : "Le moteur de fabrication est momentanément indisponible.",
    }, { status: missingConfig ? 503 : 502, headers: { "Cache-Control": "no-store" } });
  }
}
