import crypto from "node:crypto";
import type { Application, Request, Response } from "express";
import { z } from "zod";
import { pool } from "./db.js";
import { generateDemandMatches } from "./demand-matching.js";
import { createDemandProposal } from "./demand-proposal.js";
import { resolveDemandSupplyRfq, upsertDemandSupplyRfq } from "./demand-supply-rfq.js";

const intakeSchema = z.object({
  companyName: z.string().trim().min(2).max(255),
  contactName: z.string().trim().min(2).max(255),
  email: z.string().trim().email().max(255),
  phone: z.string().trim().max(80).optional().default(""),
  targetTonnes: z.coerce.number().positive().max(10_000_000),
  claimPurpose: z.enum(["voluntary_offset", "climate_contribution"]).default("voluntary_offset"),
  preferredRegistry: z.string().trim().max(120).optional().default(""),
  preferredCountry: z.string().trim().max(100).optional().default(""),
  preferredProjectType: z.string().trim().max(180).optional().default(""),
  desiredBy: z.string().date().optional().or(z.literal("")),
  notes: z.string().trim().max(3000).optional().default(""),
  privacyConsent: z.literal(true),
  website: z.string().max(0).optional().default(""),
});

const attempts = new Map<string, number[]>();
const WINDOW_MS = 10 * 60_000;
const MAX_ATTEMPTS = 6;

function clientKey(req: Request) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0]?.trim();
  return forwarded || req.ip || "unknown";
}

function rateLimited(req: Request) {
  const key = clientKey(req);
  const now = Date.now();
  const recent = (attempts.get(key) || []).filter((at) => now - at < WINDOW_MS);
  recent.push(now);
  attempts.set(key, recent);
  return recent.length > MAX_ATTEMPTS;
}

function leadScore(targetTonnes: number, phone: string, hasPreferences: boolean) {
  let score = 62;
  if (targetTonnes >= 100_000) score += 20;
  else if (targetTonnes >= 10_000) score += 15;
  else if (targetTonnes >= 1_000) score += 10;
  else if (targetTonnes >= 100) score += 5;
  if (phone) score += 3;
  if (hasPreferences) score += 2;
  return Math.min(100, score);
}

function protocolCode() {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `ECOT-${date}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

async function processOpportunity(opportunityId: number, targetTonnes: number) {
  const matching = await generateDemandMatches(opportunityId);
  const coveredTonnes = Number(matching.coveredTonnes || 0);
  const uncoveredTonnes = Number(matching.uncoveredTonnes || 0);

  if (matching.fullyCovered) {
    await resolveDemandSupplyRfq(opportunityId, coveredTonnes).catch(() => undefined);
    const proposal = await createDemandProposal({
      opportunityId,
      validityMinutes: 1440,
      notes: "Draft gerado automaticamente a partir de demanda recebida no site. Revisão comercial obrigatória antes de envio ao cliente.",
    }).catch(() => null);
    await pool.query(`
      UPDATE demand_opportunities
      SET status='matched',
          constraints=constraints || $2::jsonb,
          updated_at=NOW()
      WHERE id=$1`, [opportunityId, JSON.stringify({
      websiteInboundProcessedAt: new Date().toISOString(),
      coveredTonnes,
      uncoveredTonnes,
      coveragePct: Number(matching.coveragePct || 0),
      proposalDraftId: proposal && typeof proposal === "object" && "id" in proposal ? Number((proposal as { id: unknown }).id) : null,
      nextAction: "commercial_review",
    })]);
    return { fullyCovered: true, coveredTonnes, uncoveredTonnes };
  }

  await pool.query(`
    UPDATE demand_opportunities
    SET status='sourcing_required',
        constraints=constraints || $2::jsonb,
        updated_at=NOW()
    WHERE id=$1`, [opportunityId, JSON.stringify({
    websiteInboundProcessedAt: new Date().toISOString(),
    coveredTonnes,
    uncoveredTonnes,
    coveragePct: Number(matching.coveragePct || 0),
    sourcingRequired: true,
    nextAction: "source_more_credits",
  })]);

  await upsertDemandSupplyRfq({
    opportunityId,
    targetTonnes,
    coveredTonnes,
    gapTonnes: uncoveredTonnes,
    source: "website_inbound",
  });
  return { fullyCovered: false, coveredTonnes, uncoveredTonnes };
}

export function registerPublicCorporateDemandRoutes(app: Application) {
  app.post("/api/public/corporate-demand", async (req: Request, res: Response) => {
    if (rateLimited(req)) return res.status(429).json({ error: "Muitas solicitações em pouco tempo. Aguarde alguns minutos e tente novamente." });
    const parsed = intakeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Revise os dados da solicitação.", details: parsed.error.flatten() });

    try {
      const d = parsed.data;
      const protocol = protocolCode();
      const normalizedKey = `${d.companyName.toLowerCase()}|${d.email.toLowerCase()}`;
      const sourceReference = `web-${crypto.createHash("sha256").update(normalizedKey).digest("hex").slice(0, 24)}`;
      const score = leadScore(d.targetTonnes, d.phone, Boolean(d.preferredRegistry || d.preferredCountry || d.preferredProjectType));
      const accountMetadata = {
        inbound: true,
        channel: "ecotracker_site",
        privacyConsent: true,
        privacyConsentAt: new Date().toISOString(),
        latestProtocol: protocol,
      };

      const account = (await pool.query(`
        INSERT INTO demand_accounts
          (source,source_reference,company_name,country,contact_name,contact_email,contact_phone,lead_score,notes,metadata,last_checked_at)
        VALUES('website_inbound',$1,$2,'Brasil',$3,$4,$5,$6,$7,$8::jsonb,NOW())
        ON CONFLICT(source,source_reference) DO UPDATE SET
          company_name=EXCLUDED.company_name,
          contact_name=EXCLUDED.contact_name,
          contact_email=EXCLUDED.contact_email,
          contact_phone=COALESCE(NULLIF(EXCLUDED.contact_phone,''),demand_accounts.contact_phone),
          lead_score=GREATEST(demand_accounts.lead_score,EXCLUDED.lead_score),
          notes=COALESCE(NULLIF(EXCLUDED.notes,''),demand_accounts.notes),
          metadata=demand_accounts.metadata || EXCLUDED.metadata,
          last_checked_at=NOW(),updated_at=NOW()
        RETURNING *`, [
        sourceReference,d.companyName,d.contactName,d.email,d.phone || null,score,d.notes || null,JSON.stringify(accountMetadata),
      ])).rows[0];

      const constraints = {
        websiteInbound: true,
        protocol,
        desiredBy: d.desiredBy || null,
        privacyConsent: true,
        customerRequestedTonnes: d.targetTonnes,
      };
      const priorityScore = Math.min(100, score + (d.targetTonnes >= 10_000 ? 5 : d.targetTonnes >= 1_000 ? 3 : 0));
      const opportunity = (await pool.query(`
        INSERT INTO demand_opportunities
          (account_id,status,target_tonnes,target_basis,claim_purpose,preferred_country,preferred_registry,
           preferred_project_type,priority_score,constraints,notes)
        VALUES($1,'identified',$2,'custom',$3,$4,$5,$6,$7,$8::jsonb,$9)
        RETURNING *`, [
        account.id,d.targetTonnes,d.claimPurpose,d.preferredCountry || null,d.preferredRegistry || null,
        d.preferredProjectType || null,priorityScore,JSON.stringify(constraints),d.notes || null,
      ])).rows[0];

      let automation: { fullyCovered: boolean; coveredTonnes: number; uncoveredTonnes: number } | null = null;
      try {
        automation = await processOpportunity(Number(opportunity.id), d.targetTonnes);
      } catch (error) {
        console.warn("[public-demand] automatic matching/RFQ failed", error);
        await pool.query(`
          UPDATE demand_opportunities SET
            constraints=constraints || $2::jsonb,updated_at=NOW()
          WHERE id=$1`, [opportunity.id, JSON.stringify({
          websiteInboundAutomationErrorAt: new Date().toISOString(),
          automationRetryRequired: true,
        })]).catch(() => undefined);
      }

      return res.status(201).json({
        received: true,
        protocol,
        targetTonnes: d.targetTonnes,
        claimPurpose: d.claimPurpose,
        status: automation?.fullyCovered ? "commercial_review" : "sourcing_and_validation",
        message: automation?.fullyCovered
          ? "Recebemos sua demanda e já encontramos cobertura inicial. A oferta seguirá para revisão comercial antes do envio."
          : "Recebemos sua demanda. O EcoTracker iniciou a composição e validação do supply para preparar sua oferta.",
      });
    } catch (error) {
      console.error("[public-demand] intake failed", error);
      return res.status(500).json({ error: "Não foi possível registrar a solicitação agora. Tente novamente em alguns instantes." });
    }
  });
}
