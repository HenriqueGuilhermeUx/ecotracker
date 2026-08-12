type Json = Record<string, unknown>;

const text = (value: unknown) => String(value || "").trim();
const lower = (value: unknown) => text(value).toLowerCase();
const details = (asset: Json): Json => asset.monitor_details && typeof asset.monitor_details === "object" && !Array.isArray(asset.monitor_details)
  ? asset.monitor_details as Json
  : {};

function looksPortuguese(value: string) {
  const sample = value.toLowerCase();
  return /[áàâãéêíóôõúç]/.test(sample)
    || /\b(projeto|crédito|carbono|emissões|florestal|agricultura|conservação|energia|redução|remoção|famílias|comunidades)\b/.test(sample);
}

function projectKindPt(description: string, asset: Json) {
  const source = description.toLowerCase();
  const assetType = lower(asset.asset_type);
  const methodology = lower(asset.methodology);
  const haystack = `${source} ${assetType} ${methodology}`;

  if (/regenerative agriculture|regenerative farming|soil carbon|smallholder farm/.test(haystack)) {
    return "Projeto de agricultura regenerativa que melhora o manejo do solo, a resiliência das propriedades rurais e o armazenamento de carbono.";
  }
  if (/solar cooking|solar cooker|clean cooking|cookstove|cook stove/.test(haystack)) {
    return "Projeto de cocção limpa/solar que reduz o uso de combustíveis tradicionais, as emissões associadas e a pressão sobre recursos florestais.";
  }
  if (/biogas|biodigester|digester/.test(haystack)) {
    return "Projeto de biogás que aproveita resíduos orgânicos para gerar energia mais limpa e reduzir emissões de metano e o uso de combustíveis convencionais.";
  }
  if (/avoided deforestation|prevents deforestation|forest conservation|forest protection|redd\+|\bredd\b/.test(haystack)) {
    return "Projeto de conservação florestal que busca evitar o desmatamento, proteger estoques de carbono e fortalecer benefícios ambientais e sociais locais.";
  }
  if (/reforestation|afforestation|revegetation|forest restoration/.test(haystack)) {
    return "Projeto de restauração e recomposição florestal voltado à remoção de CO₂ da atmosfera, recuperação de ecossistemas e aumento dos estoques de carbono.";
  }
  if (/mangrove|blue carbon|seagrass|coastal wetland/.test(haystack)) {
    return "Projeto de carbono azul e conservação costeira, com foco na proteção ou restauração de ecossistemas que armazenam carbono e sustentam biodiversidade.";
  }
  if (/biochar/.test(haystack)) {
    return "Projeto de remoção de carbono por biochar, convertendo biomassa em material estável que pode armazenar carbono por longos períodos e melhorar o solo.";
  }
  if (/direct air capture|dac\b/.test(haystack)) {
    return "Projeto de remoção de CO₂ por captura direta do ar, com armazenamento durável do carbono capturado.";
  }
  if (/methane|landfill|waste gas|manure/.test(haystack)) {
    return "Projeto de redução de metano por captura, tratamento ou aproveitamento de gases provenientes de resíduos, aterros ou atividades agropecuárias.";
  }
  if (/wind power|wind farm|wind energy/.test(haystack)) {
    return "Projeto de energia eólica que substitui geração mais intensiva em carbono e contribui para a redução de emissões do sistema elétrico.";
  }
  if (/solar power|photovoltaic|solar energy/.test(haystack)) {
    return "Projeto de energia solar que amplia a geração renovável e reduz emissões associadas a fontes energéticas mais intensivas em carbono.";
  }
  if (/renewable energy|hydropower|hydroelectric/.test(haystack)) {
    return "Projeto de energia renovável voltado à substituição de fontes mais intensivas em carbono e à redução de emissões de gases de efeito estufa.";
  }
  if (/electric vehicle|e-mobility|electromobility|transport/.test(haystack)) {
    return "Projeto de mobilidade de baixo carbono que reduz emissões do transporte por meio de tecnologias e operações mais eficientes ou eletrificadas.";
  }
  if (/water|purification|safe drinking/.test(haystack)) {
    return "Projeto de acesso e tratamento de água que pode reduzir emissões associadas à fervura ou ao tratamento convencional e gerar benefícios sociais locais.";
  }
  if (/environmental conservation|biodiversity|conservation/.test(haystack)) {
    return "Projeto de conservação ambiental que protege ecossistemas, biodiversidade e estoques de carbono, com benefícios climáticos e socioambientais associados.";
  }
  return null;
}

function knownDescriptionPt(description: string) {
  const source = description.toLowerCase();
  if (source.includes("smallholder farms regenerative agriculture")) {
    return "Agricultura regenerativa em pequenas propriedades rurais, com práticas voltadas à saúde do solo, resiliência produtiva e armazenamento de carbono.";
  }
  if (source.includes("award winning evas project") && (source.includes("deforestation") || source.includes("environmental conservation"))) {
    return "Projeto EVAS premiado que ajuda a evitar o desmatamento e ampliar a conservação ambiental, gerando benefícios climáticos e locais associados.";
  }
  if (source.includes("sichuan") && source.includes("rural") && source.includes("biogas")) {
    return "Programa de desenvolvimento de biogás para famílias rurais de baixa renda em Sichuan, na China, reduzindo emissões por meio do aproveitamento energético de resíduos orgânicos.";
  }
  if (source.includes("solar cooking") && source.includes("refugee") && source.includes("chad")) {
    return "Projeto de cocção solar para famílias refugiadas no Chade, reduzindo o consumo de combustíveis tradicionais, emissões e pressão sobre recursos florestais.";
  }
  return null;
}

export function localizeMarketplaceAssetPt(asset: Json) {
  const original = text(asset.description);
  if (!original || looksPortuguese(original)) return asset;

  const localized = knownDescriptionPt(original) || projectKindPt(original, asset) || [
    `Projeto de crédito de carbono registrado em ${text(asset.registry) || "registry reconhecido"}.`,
    text(asset.location) ? `Localização informada: ${text(asset.location)}.` : "",
    text(asset.vintage) ? `Vintage ${text(asset.vintage)}.` : "",
    "O EcoTracker apresenta esta síntese em português para facilitar a leitura; a descrição original do provedor permanece preservada para auditoria.",
  ].filter(Boolean).join(" ");

  return {
    ...asset,
    description: localized,
    monitor_details: {
      ...details(asset),
      originalDescription: original,
      marketplaceDescriptionLocale: "pt-BR",
      marketplaceDescriptionMode: knownDescriptionPt(original) ? "curated-translation" : projectKindPt(original, asset) ? "structured-localization" : "registry-summary",
    },
  };
}
