import { pool, withTransaction } from "./db.js";

export type FgvInventoryInput = {
  year: number;
  scope1Tonnes?: number | null;
  scope2LocationTonnes?: number | null;
  scope2MarketTonnes?: number | null;
  scope3Tonnes?: number | null;
  biogenicTonnes?: number | null;
  removalsTonnes?: number | null;
  reportedTotalTonnes?: number | null;
  verificationLevel?: string | null;
  verificationProvider?: string | null;
  inventoryUrl?: string | null;
  sourceUrl?: string | null;
  metadata?: Record<string, unknown>;
};

export type FgvParticipantInput = {
  participantId: string;
  companyName: string;
  legalName?: string | null;
  taxId?: string | null;
  sector?: string | null;
  subSector?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  participantUrl?: string | null;
  websiteUrl?: string | null;
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  notes?: string | null;
  metadata?: Record<string, unknown>;
  inventories?: FgvInventoryInput[];
};

function num(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function operationalTonnes(inventory: FgvInventoryInput | undefined) {
  if (!inventory) return 0;
  const scope2 = inventory.scope2MarketTonnes != null
    ? num(inventory.scope2MarketTonnes)
    : num(inventory.scope2LocationTonnes);
  return num(inventory.scope1Tonnes) + scope2;
}

export function scoreFgvDemandLead(input: FgvParticipantInput) {
  const inventories = [...(input.inventories || [])].sort((a, b) => b.year - a.year);
  const latest = inventories[0];
  const currentYear = new Date().getUTCFullYear();
  const operational = operationalTonnes(latest);
  const scope3 = num(latest?.scope3Tonnes);
  let score = 20;
  const reasons: string[] = ["Organização publica inventário corporativo de GEE no ecossistema FGV/GHG Protocol."];

  if (latest && latest.year >= currentYear - 2) {
    score += 20;
    reasons.push("Inventário recente.");
  } else if (latest) {
    score += 8;
  }

  const verification = String(latest?.verificationLevel || "").toLowerCase();
  if (["gold", "ouro", "verified", "verificado"].includes(verification)) {
    score += 20;
    reasons.push("Inventário com nível alto de verificação/publicação informado.");
  } else if (verification && verification !== "unknown") {
    score += 8;
  }

  if (operational >= 10_000) score += 20;
  else if (operational >= 1_000) score += 15;
  else if (operational >= 100) score += 10;
  else if (operational > 0) score += 5;

  if (scope3 >= 100_000) score += 10;
  else if (scope3 >= 10_000) score += 7;
  else if (scope3 > 0) score += 3;

  if (input.websiteUrl) score += 4;
  if (input.contactEmail || input.contactPhone) score += 6;

  return {
    score: Math.max(0, Math.min(100, score)),
    operationalTonnes: Number(operational.toFixed(3)),
    latestInventoryYear: latest?.year || null,
    reasons,
  };
}

export async function importFgvParticipants(participants: FgvParticipantInput[]) {
  let accountsUpserted = 0;
  let inventoriesUpserted = 0;
  const items: Array<Record<string, unknown>> = [];

  for (const participant of participants) {
    const scoring = scoreFgvDemandLead(participant);
    const item = await withTransaction(async (client) => {
      const accountResult = await client.query(`
        INSERT INTO demand_accounts
          (source,source_reference,company_name,legal_name,tax_id,sector,sub_sector,city,state,country,participant_url,
           website_url,contact_name,contact_email,contact_phone,status,lead_score,notes,metadata,last_checked_at)
        VALUES('fgv_rpe',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'scouted',$15,$16,$17::jsonb,NOW())
        ON CONFLICT(source,source_reference) DO UPDATE SET
          company_name=EXCLUDED.company_name,legal_name=COALESCE(EXCLUDED.legal_name,demand_accounts.legal_name),
          tax_id=COALESCE(EXCLUDED.tax_id,demand_accounts.tax_id),sector=COALESCE(EXCLUDED.sector,demand_accounts.sector),
          sub_sector=COALESCE(EXCLUDED.sub_sector,demand_accounts.sub_sector),city=COALESCE(EXCLUDED.city,demand_accounts.city),
          state=COALESCE(EXCLUDED.state,demand_accounts.state),country=COALESCE(EXCLUDED.country,demand_accounts.country),
          participant_url=COALESCE(EXCLUDED.participant_url,demand_accounts.participant_url),
          website_url=COALESCE(EXCLUDED.website_url,demand_accounts.website_url),
          contact_name=COALESCE(EXCLUDED.contact_name,demand_accounts.contact_name),
          contact_email=COALESCE(EXCLUDED.contact_email,demand_accounts.contact_email),
          contact_phone=COALESCE(EXCLUDED.contact_phone,demand_accounts.contact_phone),
          lead_score=GREATEST(demand_accounts.lead_score,EXCLUDED.lead_score),
          notes=COALESCE(EXCLUDED.notes,demand_accounts.notes),metadata=demand_accounts.metadata || EXCLUDED.metadata,
          last_checked_at=NOW(),updated_at=NOW()
        RETURNING *`, [
        participant.participantId,participant.companyName,participant.legalName ?? null,participant.taxId ?? null,
        participant.sector ?? null,participant.subSector ?? null,participant.city ?? null,participant.state ?? null,
        participant.country || "Brasil",participant.participantUrl ?? `https://registropublicodeemissoes.fgv.br/participantes/${encodeURIComponent(participant.participantId)}`,
        participant.websiteUrl ?? null,participant.contactName ?? null,participant.contactEmail ?? null,participant.contactPhone ?? null,
        scoring.score,participant.notes ?? null,JSON.stringify({ ...(participant.metadata || {}), demandScoring: scoring }),
      ]);
      const account = accountResult.rows[0];

      for (const inventory of participant.inventories || []) {
        await client.query(`
          INSERT INTO demand_inventories
            (account_id,inventory_year,scope1_tonnes,scope2_location_tonnes,scope2_market_tonnes,scope3_tonnes,
             biogenic_tonnes,removals_tonnes,reported_total_tonnes,verification_level,verification_provider,
             inventory_url,source_url,metadata)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)
          ON CONFLICT(account_id,inventory_year) DO UPDATE SET
            scope1_tonnes=COALESCE(EXCLUDED.scope1_tonnes,demand_inventories.scope1_tonnes),
            scope2_location_tonnes=COALESCE(EXCLUDED.scope2_location_tonnes,demand_inventories.scope2_location_tonnes),
            scope2_market_tonnes=COALESCE(EXCLUDED.scope2_market_tonnes,demand_inventories.scope2_market_tonnes),
            scope3_tonnes=COALESCE(EXCLUDED.scope3_tonnes,demand_inventories.scope3_tonnes),
            biogenic_tonnes=COALESCE(EXCLUDED.biogenic_tonnes,demand_inventories.biogenic_tonnes),
            removals_tonnes=COALESCE(EXCLUDED.removals_tonnes,demand_inventories.removals_tonnes),
            reported_total_tonnes=COALESCE(EXCLUDED.reported_total_tonnes,demand_inventories.reported_total_tonnes),
            verification_level=EXCLUDED.verification_level,
            verification_provider=COALESCE(EXCLUDED.verification_provider,demand_inventories.verification_provider),
            inventory_url=COALESCE(EXCLUDED.inventory_url,demand_inventories.inventory_url),
            source_url=COALESCE(EXCLUDED.source_url,demand_inventories.source_url),
            metadata=demand_inventories.metadata || EXCLUDED.metadata,updated_at=NOW()`, [
          account.id,inventory.year,inventory.scope1Tonnes ?? null,inventory.scope2LocationTonnes ?? null,
          inventory.scope2MarketTonnes ?? null,inventory.scope3Tonnes ?? null,inventory.biogenicTonnes ?? null,
          inventory.removalsTonnes ?? null,inventory.reportedTotalTonnes ?? null,inventory.verificationLevel || "unknown",
          inventory.verificationProvider ?? null,inventory.inventoryUrl ?? null,inventory.sourceUrl ?? participant.participantUrl ?? null,
          JSON.stringify(inventory.metadata || {}),
        ]);
        inventoriesUpserted += 1;
      }
      return account;
    });
    accountsUpserted += 1;
    items.push({ id: item.id, companyName: item.company_name, leadScore: item.lead_score, ...scoring });
  }

  return { accountsUpserted, inventoriesUpserted, items };
}

export function fgvDemandScoutStatus() {
  return {
    source: "fgv_rpe",
    participantsUrl: "https://registropublicodeemissoes.fgv.br/participantes",
    observedApiHost: "https://registropublicodeemissoesapi.fgv.br",
    automaticScrapeEnabled: false,
    importEnabled: true,
    note: "O RPE é usado como fonte de prospecção de demanda corporativa. O contrato público de API ainda precisa ser confirmado antes de automatizar crawling; não inferimos endpoints privados/autenticados.",
  };
}
