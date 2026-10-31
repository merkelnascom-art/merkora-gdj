import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAdminAccess } from "@/lib/server/admin-access";
import { evaluateLaunchFactoryHandoff } from "@/lib/factory/launch-factory-handoff";
import { callUserData, getAccessToken, isSameOrigin } from "@/lib/server/supabase-rest";

export const dynamic = "force-dynamic";
const fail = (status: number, error: string) => NextResponse.json({ error }, { status });
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);

type Row = Record<string, unknown>;

const FACTORY_TASKS = [
  { task_key: "prepare_specification", state: "not_started", dependencies: [], evidence_required: true, external_side_effect: false, result_is_known: true },
  { task_key: "generate_application", state: "not_started", dependencies: ["prepare_specification"], evidence_required: true, external_side_effect: false, result_is_known: true },
  { task_key: "run_quality_checks", state: "not_started", dependencies: ["generate_application"], evidence_required: true, external_side_effect: false, result_is_known: true },
  { task_key: "repair_and_retest", state: "not_started", dependencies: ["run_quality_checks"], evidence_required: true, external_side_effect: false, result_is_known: true },
  { task_key: "human_delivery_review", state: "not_started", dependencies: ["repair_and_retest"], evidence_required: true, external_side_effect: true, result_is_known: true },
];

export async function GET() {
  const access = await getAdminAccess();
  if (!access.ok) return fail(access.reason === "unauthenticated" ? 401 : 403, "Accès administrateur requis.");
  try {
    const token = await getAccessToken(await cookies());
    if (!token) return fail(401, "Session expirée. Reconnectez-vous.");
    const result = await callUserData(
      "client_project_launches?select=id,request_id,client_user_id,quote_version_id,invoice_id,launched_by,required_amount,invoice_total_at_launch,confirmed_amount_at_launch,launch_message,launched_at&order=launched_at.desc&limit=200",
      "GET", token,
    );
    if (!result.ok) return fail(502, "Impossible de charger l’historique des lancements. Vérifiez l’exposition Data API et les règles Supabase.");
    return NextResponse.json({ launches: Array.isArray(result.data) ? result.data : [] });
  } catch {
    return fail(503, "Le service de lancement est momentanément indisponible.");
  }
}

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return fail(403, "Requête non autorisée.");
  const access = await getAdminAccess();
  if (!access.ok) return fail(access.reason === "unauthenticated" ? 401 : 403, "Accès administrateur requis.");

  let body: unknown;
  try { body = await request.json(); } catch { return fail(400, "Données invalides."); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail(400, "Données invalides.");
  const value = body as Row;
  if (!uuid(value.invoiceId) || !Number.isSafeInteger(value.requiredAmount) ||
      Number(value.requiredAmount) <= 0 ||
      typeof value.message !== "string" || !value.message.trim() || value.message.length > 1200) {
    return fail(400, "Facture, montant requis ou message de lancement invalide.");
  }

  try {
    const token = await getAccessToken(await cookies());
    if (!token) return fail(401, "Session expirée. Reconnectez-vous.");

    const invoiceResult = await callUserData(
      `client_invoices?select=id,quote_version_id,client_user_id,total_amount,description&id=eq.${encodeURIComponent(String(value.invoiceId))}&limit=1`,
      "GET", token,
    );
    if (!invoiceResult.ok || !Array.isArray(invoiceResult.data) || !invoiceResult.data.length) return fail(404, "Facture introuvable.");
    const invoice = invoiceResult.data[0] as { id: string; quote_version_id: string; client_user_id: string; total_amount: number; description: string };
    const invoiceTotal = Number(invoice.total_amount);
    const requiredAmount = Number(value.requiredAmount);
    if (!Number.isSafeInteger(invoiceTotal) || invoiceTotal <= 0 || requiredAmount > invoiceTotal) {
      return fail(400, "Le montant requis doit être positif et ne peut pas dépasser le total de la facture.");
    }

    const versionResult = await callUserData(
      `client_quote_versions?select=id,quote_id,client_user_id,version_number,published_at&id=eq.${encodeURIComponent(invoice.quote_version_id)}&limit=1`,
      "GET", token,
    );
    if (!versionResult.ok || !Array.isArray(versionResult.data) || !versionResult.data.length) return fail(409, "Version du devis introuvable.");
    const version = versionResult.data[0] as { id: string; quote_id: string; client_user_id: string; version_number: number; published_at: string | null };
    if (version.client_user_id !== invoice.client_user_id || !version.published_at) return fail(409, "La facture ne correspond pas à une version publiée du devis.");
    const latestVersion = await callUserData(
      `client_quote_versions?select=id&quote_id=eq.${encodeURIComponent(version.quote_id)}&client_user_id=eq.${encodeURIComponent(invoice.client_user_id)}&published_at=not.is.null&order=version_number.desc&limit=1`,
      "GET", token,
    );
    if (!latestVersion.ok) return fail(502, "Impossible de vérifier la dernière version publiée du devis.");
    if (!Array.isArray(latestVersion.data) || !latestVersion.data.length ||
        String((latestVersion.data[0] as { id: string }).id) !== version.id) {
      return fail(409, "Une version plus récente du devis a été publiée. Le client doit l’examiner et l’accepter avant le lancement.");
    }

    const [decisionResult, quoteResult, declarationResult, reviewResult] = await Promise.all([
      callUserData(
        `client_quote_decisions?select=id,decision&quote_version_id=eq.${encodeURIComponent(version.id)}&client_user_id=eq.${encodeURIComponent(invoice.client_user_id)}`,
        "GET", token,
      ),
      callUserData(
        `client_quotes?select=id,request_id,client_user_id&id=eq.${encodeURIComponent(version.quote_id)}&limit=1`,
        "GET", token,
      ),
      callUserData(
        `client_payment_declarations?select=id,amount,client_user_id,invoice_id&invoice_id=eq.${encodeURIComponent(invoice.id)}&client_user_id=eq.${encodeURIComponent(invoice.client_user_id)}`,
        "GET", token,
      ),
      callUserData(
        `client_payment_reviews?select=payment_declaration_id,status&invoice_id=eq.${encodeURIComponent(invoice.id)}&client_user_id=eq.${encodeURIComponent(invoice.client_user_id)}&status=eq.confirmed`,
        "GET", token,
      ),
    ]);
    if (![decisionResult, quoteResult, declarationResult, reviewResult].every(r => r.ok)) return fail(502, "Impossible de vérifier l’accord, le dossier et les paiements confirmés.");
    if (!Array.isArray(decisionResult.data) || !decisionResult.data.some((d: { decision?: string }) => d.decision === "accepted")) {
      return fail(409, "Le client doit avoir accepté précisément cette version du devis avant le lancement.");
    }
    if (!Array.isArray(quoteResult.data) || !quoteResult.data.length) return fail(404, "Dossier de devis introuvable.");
    const quote = quoteResult.data[0] as { id: string; request_id: string; client_user_id: string };
    if (quote.client_user_id !== invoice.client_user_id) return fail(409, "Le devis et la facture ne correspondent pas au même client.");

    const declarations = Array.isArray(declarationResult.data) ? declarationResult.data as Array<{ id: string; amount: number }> : [];
    const confirmedIds = new Set(
      (Array.isArray(reviewResult.data) ? reviewResult.data as Array<{ payment_declaration_id: string }> : [])
        .map(r => r.payment_declaration_id),
    );
    const confirmedAmount = declarations
      .filter(d => confirmedIds.has(d.id))
      .reduce((sum, d) => sum + Number(d.amount), 0);
    if (confirmedAmount < requiredAmount) {
      return fail(409, `Paiement confirmé insuffisant : ${confirmedAmount.toLocaleString("fr-FR")} FCFA confirmé sur ${requiredAmount.toLocaleString("fr-FR")} FCFA requis pour démarrer.`);
    }
    if (confirmedAmount > invoiceTotal) return fail(409, "Le cumul des paiements confirmés dépasse le total de la facture. Vérification administrative nécessaire.");

    const existing = await callUserData(
      `client_project_launches?select=id,launched_at&request_id=eq.${encodeURIComponent(quote.request_id)}&limit=1`,
      "GET", token,
    );
    if (!existing.ok) return fail(502, "Impossible de vérifier si le projet a déjà été lancé.");
    if (Array.isArray(existing.data) && existing.data.length) return fail(409, "Ce projet a déjà été officiellement lancé. Son historique est conservé.");

    const saved = await callUserData("client_project_launches", "POST", token, {
      request_id: quote.request_id,
      client_user_id: invoice.client_user_id,
      quote_version_id: version.id,
      invoice_id: invoice.id,
      launched_by: access.user.id,
      required_amount: requiredAmount,
      invoice_total_at_launch: invoiceTotal,
      confirmed_amount_at_launch: confirmedAmount,
      launch_message: value.message.trim(),
    }, "return=representation");
    if (!saved.ok) {
      const databaseError = saved.data && typeof saved.data === "object" ? saved.data as Record<string, unknown> : {};
      if (databaseError.code === "23505") return fail(409, "Ce projet vient déjà d’être lancé. Son historique est conservé.");
      return fail(502, "Le lancement n’a pas été enregistré. Aucune facture ni déclaration de paiement n’a été modifiée.");
    }

    const statusUpdate = await callUserData(
      `client_requests?id=eq.${encodeURIComponent(quote.request_id)}&user_id=eq.${encodeURIComponent(invoice.client_user_id)}`,
      "PATCH", token,
      { admin_status: "in_progress", updated_at: new Date().toISOString() },
      "return=representation",
    );
    const launch = Array.isArray(saved.data) ? saved.data[0] as Row | undefined : undefined;
    let factoryHandoff: Row = {
      status: "handoff_pending",
      message: "Le lancement est enregistré ; la préparation de fabrication doit être réconciliée.",
    };

    // The commercial launch is the durable handoff key. Queue only when the
    // exact request, owner-matched project, plan, approvals and AI consent exist.
    if (launch && uuid(launch.id)) {
      const requestLink = await callUserData(
        `client_requests?select=id,user_id,project_id&id=eq.${encodeURIComponent(quote.request_id)}&user_id=eq.${encodeURIComponent(invoice.client_user_id)}&limit=1`,
        "GET", token,
      );
      if (requestLink.ok) {
        const requestRows = Array.isArray(requestLink.data) ? requestLink.data as Row[] : [];
        const requestRow = requestRows[0];
        const projectId = typeof requestRow?.project_id === "string" ? requestRow.project_id : "";
        const projectResult = projectId
          ? await callUserData(
              `user_projects?select=id,user_id&id=eq.${encodeURIComponent(projectId)}&user_id=eq.${encodeURIComponent(invoice.client_user_id)}&limit=1`,
              "GET", token,
            )
          : { ok: true, data: [] };

        if (projectResult.ok) {
          const projectRows = Array.isArray(projectResult.data) ? projectResult.data as Row[] : [];
          const planResult = projectRows.length
            ? await callUserData(
                `project_memory_plan_versions?select=version,payload,payload_digest,scope_digest,source_brief_version&project_id=eq.${encodeURIComponent(projectId)}&order=version.desc&limit=1`,
                "GET", token,
              )
            : { ok: true, data: [] };

          if (planResult.ok) {
            const planRows = Array.isArray(planResult.data) ? planResult.data as Row[] : [];
            const latestPlan = planRows[0];
            const approvalResult = latestPlan && Number.isSafeInteger(latestPlan.version)
              ? await callUserData(
                  `project_memory_approvals?select=id,project_id,plan_version,approval_kind,decision,plan_digest,scope_digest,ai_processing_consent&project_id=eq.${encodeURIComponent(projectId)}&plan_version=eq.${latestPlan.version}`,
                  "GET", token,
                )
              : { ok: true, data: [] };

            if (approvalResult.ok) {
              const readiness = evaluateLaunchFactoryHandoff({
                projectId,
                ownerId: invoice.client_user_id,
                requestId: quote.request_id,
                requests: requestRows,
                projects: projectRows,
                plans: planRows,
                approvals: Array.isArray(approvalResult.data) ? approvalResult.data : [],
              });

              if (readiness.status !== "ready") {
                factoryHandoff = {
                  status: readiness.status,
                  message: readiness.status === "needs_project_link"
                    ? "Le lancement est enregistré, mais le projet doit être associé au compte client exact avant fabrication."
                    : readiness.status === "awaiting_plan"
                      ? "Le lancement est enregistré. MerKora attend le plan de projet versionné."
                      : "Le lancement est enregistré. MerKora attend les trois validations exactes et le consentement IA du client.",
                  ...(readiness.status === "awaiting_approval"
                    ? { missingApprovals: readiness.missingApprovals, missingConsent: readiness.missingConsent === true }
                    : {}),
                };
              } else {
                const existingJob = await callUserData(
                  `project_factory_jobs?select=id,status&project_id=eq.${encodeURIComponent(projectId)}&correlation_id=eq.${encodeURIComponent(String(launch.id))}&limit=1`,
                  "GET", token,
                );
                if (!existingJob.ok) {
                  factoryHandoff = { status: "handoff_pending", message: "Le lancement est enregistré ; la vérification d'un travail déjà créé a échoué." };
                } else if (Array.isArray(existingJob.data) && existingJob.data.length) {
                  const existingRow = existingJob.data[0] as Row;
                  factoryHandoff = { status: "already_queued", jobId: existingRow.id, jobStatus: existingRow.status };
                } else {
                  const handoff = await callUserData("rpc/create_factory_job_with_tasks", "POST", token, {
                    p_job: {
                      project_id: projectId,
                      plan_version: readiness.planVersion,
                      plan_digest: readiness.planDigest,
                      scope_digest: readiness.scopeDigest,
                      status: "queued",
                      manifest: {
                        schemaVersion: 1,
                        kind: "merkora_project_factory_job",
                        projectId,
                        planVersion: readiness.planVersion,
                        sourceBriefVersion: readiness.sourceBriefVersion,
                        approvalIds: readiness.approvalIds,
                        commercialLaunchId: launch.id,
                        stages: FACTORY_TASKS.map((task) => task.task_key),
                        executionMode: "manual_worker_required",
                        deliveryRequiresHumanReview: true,
                      },
                      requested_by: access.user.id,
                      authorized_by: access.user.id,
                      approval_ids: readiness.approvalIds,
                      correlation_id: launch.id,
                    },
                    p_tasks: FACTORY_TASKS,
                  });
                  const result = handoff.data && typeof handoff.data === "object" ? handoff.data as Row : {};
                  if (handoff.ok && typeof result.job_id === "string" && result.task_count === FACTORY_TASKS.length) {
                    factoryHandoff = {
                      status: "queued",
                      jobId: result.job_id,
                      taskCount: result.task_count,
                      executionStarted: false,
                      message: "Le travail de fabrication est créé et attend le worker. Aucun modèle IA ni déploiement n'a été lancé.",
                    };
                  } else {
                    factoryHandoff = {
                      status: "handoff_pending",
                      message: "Le lancement est enregistré, mais la création atomique du travail a échoué. Une réconciliation peut être relancée sans dupliquer le lancement.",
                    };
                  }
                }
              }
            } else {
              factoryHandoff = { status: "handoff_pending", message: "Le lancement est enregistré ; la vérification des validations n'a pas abouti." };
            }
          } else {
            factoryHandoff = { status: "handoff_pending", message: "Le lancement est enregistré ; la lecture du plan n'a pas abouti." };
          }
        } else {
          factoryHandoff = { status: "handoff_pending", message: "Le lancement est enregistré ; la vérification du projet client n'a pas abouti." };
        }
      } else {
        factoryHandoff = { status: "handoff_pending", message: "Le lancement est enregistré ; la lecture de la demande commerciale n'a pas abouti." };
      }
    }

    return NextResponse.json({
      saved: true,
      launch,
      factoryHandoff,
      statusUpdated: statusUpdate.ok && Array.isArray(statusUpdate.data) && statusUpdate.data.length > 0,
      message: statusUpdate.ok && Array.isArray(statusUpdate.data) && statusUpdate.data.length > 0
        ? "Le lancement officiel est enregistré. MerKora prépare automatiquement la fabrication si le projet, le plan et les validations sont prêts."
        : "Le lancement officiel est enregistré et visible du client. Le statut administratif du dossier n’a pas pu être actualisé automatiquement.",
    });
  } catch {
    return fail(503, "Le service de lancement est momentanément indisponible.");
  }
}
