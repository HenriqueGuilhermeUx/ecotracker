export type ClaimPurpose = "voluntary_offset" | "climate_contribution" | "ecological_contribution" | "compliance";

type AssetLike = Record<string, unknown>;

export type EligibilityDecision = {
  allowed: boolean;
  purpose: ClaimPurpose;
  shelf: "verified_compensation" | "climate_contribution" | "restricted";
  reason: string;
  warnings: string[];
};

const dateMs = (value: unknown): number | null => {
  if (!value) return null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
};

const bool = (value: unknown) => value === true || value === "true" || value === 1 || value === "1";

export function normalizeClaimPurpose(value: unknown): ClaimPurpose {
  const raw = String(value || "voluntary_offset").trim().toLowerCase();
  if (["neutralization", "neutralisation", "offset", "offsetting", "compensation", "compensacao", "compensação", "voluntary_offset"].includes(raw)) return "voluntary_offset";
  if (["climate_contribution", "contribution", "contribuicao", "contribuição", "climate-action"].includes(raw)) return "climate_contribution";
  if (["ecological_contribution", "ecological", "ecossistemico", "ecossistêmico"].includes(raw)) return "ecological_contribution";
  if (["compliance", "corsia", "article6", "article_6"].includes(raw)) return "compliance";
  return "voluntary_offset";
}

export function evaluateAssetEligibility(asset: AssetLike, purposeInput: unknown, requestedKg?: number): EligibilityDecision {
  const purpose = normalizeClaimPurpose(purposeInput);
  const now = Date.now();
  const warnings: string[] = [];
  const active = bool(asset.active);
  const category = String(asset.claim_category || "climate_contribution");
  const status = String(asset.eligibility_status || "under_review");
  const sourceUnitStatus = String(asset.source_unit_status || "unknown");
  const validUntil = dateMs(asset.commercial_valid_until);
  const offerExpiresAt = dateMs(asset.offer_expires_at);
  const checkedAt = dateMs(asset.eligibility_checked_at);
  const retirementSupported = bool(asset.retirement_supported);
  const fractionalSupported = bool(asset.fractional_retirement_supported);
  const granularityKg = Math.max(1, Number(asset.retirement_granularity_kg || 1000));
  const maxVintageAgeYears = Math.max(1, Number(process.env.ECOT_MAX_OFFSET_VINTAGE_AGE_YEARS || 5));
  const maxReviewAgeHours = Math.max(1, Number(process.env.ECOT_ELIGIBILITY_MAX_AGE_HOURS || 168));
  const vintageEnd = dateMs(asset.vintage_end);
  const vintageOverride = bool(asset.vintage_policy_override);

  const reject = (reason: string, shelf: EligibilityDecision["shelf"] = "restricted"): EligibilityDecision => ({
    allowed: false, purpose, shelf, reason, warnings,
  });

  if (!active) return reject("Lote inativo no EcoTracker.");
  if (["retired", "cancelled", "canceled", "suspended"].includes(sourceUnitStatus)) {
    return reject(`Unidade de origem está ${sourceUnitStatus}; não pode receber nova venda.`);
  }
  if (validUntil && validUntil < now) return reject("Validade comercial EcoTracker encerrada.");
  if (offerExpiresAt && offerExpiresAt < now) return reject("Oferta de origem expirou e precisa ser renovada.");
  if (status === "ineligible") return reject("Lote marcado como inelegível após revisão.");

  if (purpose === "voluntary_offset" || purpose === "compliance") {
    if (category !== (purpose === "compliance" ? "compliance" : "voluntary_offset")) {
      return reject(purpose === "compliance"
        ? "Lote não está classificado para uso de compliance."
        : "Este ativo é contribuição climática/ecológica e não está habilitado como compensação voluntária.");
    }
    if (status !== "eligible") return reject("Elegibilidade para compensação ainda não está aprovada.");
    if (sourceUnitStatus !== "tradable") return reject("Status registral da unidade precisa estar confirmado como tradable.");
    if (!retirementSupported) return reject("A fonte ainda não possui aposentadoria executável configurada.");
    if (!validUntil) return reject("O lote ainda não recebeu uma validade comercial EcoTracker.");
    if (!asset.registry_evidence_url && !asset.source_url) return reject("Falta evidência pública do registry/projeto de origem.");

    if (checkedAt) {
      const ageHours = (now - checkedAt) / 3_600_000;
      if (ageHours > maxReviewAgeHours) return reject(`Revisão de elegibilidade está desatualizada há mais de ${maxReviewAgeHours} horas.`);
    } else {
      return reject("Lote ainda não possui data de revisão de elegibilidade.");
    }

    if (vintageEnd && !vintageOverride) {
      const ageYears = (now - vintageEnd) / (365.25 * 24 * 3_600_000);
      if (ageYears > maxVintageAgeYears) {
        return reject(`Vintage excede a política comercial padrão de ${maxVintageAgeYears} anos. Uma exceção documentada é necessária.`);
      }
    }

    if (requestedKg && requestedKg > 0 && !fractionalSupported && requestedKg % granularityKg !== 0) {
      return reject(`Esta fonte aposenta em blocos de ${granularityKg} kg. Para compra fracionada, use um fornecedor com aposentadoria fracionária habilitada.`);
    }

    if (purpose === "compliance") {
      const corsia = String(asset.corsia_status || "not_assessed");
      const article6 = String(asset.article6_status || "not_assessed");
      if (!(["eligible", "approved", "authorized"].includes(corsia) || ["eligible", "approved", "authorized"].includes(article6))) {
        return reject("O lote não possui elegibilidade CORSIA/Artigo 6 explicitamente documentada.");
      }
    }

    if (String(asset.ccp_status || "not_assessed") !== "approved") warnings.push("Sem selo CCP aprovado registrado; isso não torna o crédito inválido, mas reduz o nível de integridade indicado pelo EcoTracker.");
    return {
      allowed: true,
      purpose,
      shelf: "verified_compensation",
      reason: "Lote apto à prateleira de compensação verificada segundo a política comercial EcoTracker.",
      warnings,
    };
  }

  if (status === "restricted") warnings.push("Uso restrito: não apresentar este ativo como crédito apto a compensação de emissões.");
  return {
    allowed: status !== "ineligible",
    purpose,
    shelf: "climate_contribution",
    reason: status === "restricted"
      ? "Ativo disponível somente para contribuição climática/ecológica, sem claim de compensação."
      : "Ativo disponível para contribuição climática/ecológica.",
    warnings,
  };
}
