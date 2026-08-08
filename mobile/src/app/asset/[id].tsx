import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { getAssets } from "../../api";
import { QuantityStepper } from "../../components/forms";
import { EmptyState, Eyebrow, LoadingBlock, PrimaryButton, Screen, StatusPill } from "../../components/ui";
import { useApp } from "../../context/AppContext";
import { colors, radius, shadow, spacing, typography } from "../../theme";
import type { Asset } from "../../types";

const money = (value: number) => value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const date = (value?: string | null) => value ? new Date(`${value}T12:00:00`).toLocaleDateString("pt-BR") : "Não informada";

export default function AssetDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { recommendationKg } = useApp();
  const [asset, setAsset] = useState<Asset | null>(null);
  const [loading, setLoading] = useState(true);
  const [quantity, setQuantity] = useState(recommendationKg);

  useEffect(() => {
    getAssets()
      .then((assets) => {
        const found = assets.find((item) => String(item.id) === String(id)) || null;
        setAsset(found);
        if (found) setQuantity(Math.max(found.min_order_kg || 1, recommendationKg));
      })
      .finally(() => setLoading(false));
  }, [id, recommendationKg]);

  const estimate = useMemo(() => {
    const price = Number(asset?.indicative_price_brl_kg);
    return Number.isFinite(price) && price > 0 ? price * quantity : null;
  }, [asset, quantity]);

  if (loading) return <Screen><LoadingBlock label="Abrindo o ativo..." /></Screen>;
  if (!asset) return <Screen><EmptyState icon="leaf-off" title="Ativo não encontrado" message="Ele pode ter sido removido ou atualizado pela fonte." /></Screen>;

  const verifiedOffset = asset.claim_category === "voluntary_offset" && asset.eligibility_status === "eligible";
  const contribution = asset.claim_category === "climate_contribution" || asset.claim_category === "ecological_contribution";
  const restricted = asset.eligibility_status === "restricted" || asset.eligibility_status === "ineligible" || asset.claim_category === "historical";
  const purpose = verifiedOffset ? "voluntary_offset" : "climate_contribution";
  const fractionalOk = Boolean(asset.fractional_retirement_supported) || quantity % Math.max(1, Number(asset.retirement_granularity_kg || 1000)) === 0;
  const canRequest = !restricted && (contribution || (verifiedOffset && fractionalOk));
  const actionTitle = verifiedOffset ? "Cotar compensação" : contribution ? "Apoiar como contribuição" : "Indisponível para compra";

  return (
    <Screen>
      <View style={styles.hero}>
        <View style={styles.heroTop}>
          <View style={styles.icon}><MaterialCommunityIcons name={verifiedOffset ? "shield-check" : asset.asset_type.includes("removal") ? "tree" : "leaf-circle"} size={32} color={colors.primary} /></View>
          <StatusPill value={asset.source_status} />
        </View>
        <Eyebrow>{verifiedOffset ? "COMPENSAÇÃO VERIFICADA" : contribution ? "CONTRIBUIÇÃO CLIMÁTICA" : "USO RESTRITO"}</Eyebrow>
        <Text style={styles.title}>{asset.project_name}</Text>
        <Text style={styles.description}>{asset.description || "Ativo ambiental monitorado pelo EcoTracker."}</Text>
        <View style={styles.tags}>
          <Tag value={asset.asset_type.replaceAll("-", " ")} />
          <Tag value={asset.quality_tier} />
          {asset.vintage ? <Tag value={`Vintage ${asset.vintage}`} /> : null}
          {asset.source_unit_status ? <Tag value={`Registry: ${asset.source_unit_status}`} /> : null}
          {asset.retirement_supported ? <Tag value="aposentadoria suportada" /> : null}
          {asset.fractional_retirement_supported ? <Tag value="fracionamento real" /> : null}
        </View>
      </View>

      <View style={styles.claimCard}>
        <MaterialCommunityIcons name={verifiedOffset ? "check-decagram" : contribution ? "leaf" : "alert-outline"} size={24} color={verifiedOffset ? colors.primary : colors.blue} />
        <View style={{ flex: 1 }}>
          <Text style={styles.blockTitle}>{verifiedOffset ? "Pode ser usado para compensação voluntária" : contribution ? "Contribuição sem claim de compensação" : "Não disponível para compensação"}</Text>
          <Text style={styles.blockCopy}>{asset.eligibility_basis || (verifiedOffset ? "O EcoTracker revisou status registral, evidência, aposentadoria e validade comercial deste lote." : "Este ativo não é promovido como offset até cumprir todos os critérios de elegibilidade.")}</Text>
        </View>
      </View>

      <View style={styles.metrics}>
        <Metric label="Preço por ECOT" value={asset.indicative_price_brl_kg ? money(Number(asset.indicative_price_brl_kg)) : "Sob consulta"} />
        <Metric label="Preço por tonelada" value={asset.indicative_price_brl_ton ? money(Number(asset.indicative_price_brl_ton)) : "Confirmar"} />
        <Metric label="Volume monitorado" value={asset.available_tons ? `${Number(asset.available_tons).toLocaleString("pt-BR", { maximumFractionDigits: 3 })} t` : "Confirmar"} />
        <Metric label="Pedido mínimo" value={`${Number(asset.min_order_kg || 1).toLocaleString("pt-BR")} ECOT`} />
        <Metric label="Validade comercial" value={date(asset.commercial_valid_until)} />
        <Metric label="Granularidade de aposentadoria" value={`${Number(asset.retirement_granularity_kg || 1000).toLocaleString("pt-BR")} kg`} />
      </View>

      <View style={styles.quantityCard}>
        <Text style={styles.blockTitle}>{verifiedOffset ? "Quanto você quer compensar?" : "Quanto impacto você quer apoiar?"}</Text>
        <Text style={styles.blockCopy}>{verifiedOffset ? "Escolha a quantidade em kg de CO₂e. A compra só avança se a fonte puder aposentar a quantidade solicitada de forma legítima." : "A contribuição é registrada separadamente e não será descrita como neutralização de emissões."}</Text>
        <QuantityStepper label="Quantidade de ECOT" helper="1 ECOT = 1 kg CO₂e alocado" value={quantity} min={asset.min_order_kg || 1} step={Math.max(1, asset.min_order_kg || 1)} onChange={setQuantity} />
        <View style={styles.estimate}>
          <View><Text style={styles.estimateLabel}>ESTIMATIVA</Text><Text style={styles.estimateValue}>{estimate == null ? "Sob consulta" : money(estimate)}</Text></View>
          <View style={{ alignItems: "flex-end" }}><Text style={styles.estimateLabel}>QUANTIDADE</Text><Text style={styles.impactValue}>{quantity.toLocaleString("pt-BR")} kg</Text></View>
        </View>
        {verifiedOffset && !fractionalOk ? <Text style={styles.warning}>Esta fonte aposenta em blocos de {Number(asset.retirement_granularity_kg || 1000).toLocaleString("pt-BR")} kg. Ajuste a quantidade ou escolha um lote com aposentadoria fracionária.</Text> : null}
        <PrimaryButton
          title={actionTitle}
          icon={canRequest ? "arrow-right" : "lock-outline"}
          disabled={!canRequest}
          onPress={() => canRequest && router.push({ pathname: "/quote/new", params: { assetId: String(asset.id), quantity: String(quantity), purpose } })}
        />
      </View>

      <View style={styles.transparencyCard}>
        <View style={styles.transparencyIcon}><MaterialCommunityIcons name="shield-check-outline" size={24} color={colors.blue} /></View>
        <View style={{ flex: 1 }}>
          <Text style={styles.blockTitle}>Transparência da fonte</Text>
          <Text style={styles.blockCopy}>{asset.monitor_details?.note || "O EcoTracker valida lote, preço, disponibilidade e regra de aposentadoria antes do pagamento."}</Text>
          {asset.registry_project_id ? <Text style={styles.evidence}>Projeto no registry: {asset.registry_project_id}</Text> : null}
          {asset.registry_batch_id ? <Text style={styles.evidence}>Lote/serial: {asset.registry_batch_id}</Text> : null}
        </View>
      </View>

      {asset.registry_evidence_url ? <PrimaryButton title="Ver evidência no registry" icon="open-in-new" secondary onPress={() => void WebBrowser.openBrowserAsync(asset.registry_evidence_url!)} /> : null}
      {asset.source_url ? <PrimaryButton title="Abrir fonte original" icon="open-in-new" secondary onPress={() => void WebBrowser.openBrowserAsync(asset.source_url!)} /> : null}
    </Screen>
  );
}

function Tag({ value }: { value: string }) {
  return <View style={styles.tag}><Text style={styles.tagText}>{value}</Text></View>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <View style={styles.metric}><Text style={styles.metricLabel}>{label}</Text><Text style={styles.metricValue}>{value}</Text></View>;
}

const styles = StyleSheet.create({
  hero: { marginTop: spacing.sm, padding: spacing.xxl, borderRadius: radius.xl, backgroundColor: colors.surfaceStrong, borderWidth: 1, borderColor: colors.borderStrong, ...shadow },
  heroTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: spacing.xxl },
  icon: { width: 58, height: 58, borderRadius: 19, alignItems: "center", justifyContent: "center", backgroundColor: colors.primaryMuted, borderWidth: 1, borderColor: colors.borderStrong },
  title: { color: colors.text, fontSize: typography.title, lineHeight: 35, fontWeight: "900", letterSpacing: -1, marginTop: spacing.sm },
  description: { color: colors.textMuted, fontSize: 14, lineHeight: 22, marginTop: spacing.md },
  tags: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginTop: spacing.xl },
  tag: { paddingHorizontal: 10, paddingVertical: 7, borderRadius: radius.pill, backgroundColor: colors.backgroundRaised, borderWidth: 1, borderColor: colors.border },
  tagText: { color: colors.textMuted, fontSize: 10, fontWeight: "700", textTransform: "capitalize" },
  claimCard: { flexDirection: "row", gap: spacing.md, marginTop: spacing.md, padding: spacing.lg, borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderStrong },
  metrics: { flexDirection: "row", flexWrap: "wrap", gap: spacing.md, marginTop: spacing.md },
  metric: { width: "47%", padding: spacing.lg, borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  metricLabel: { color: colors.textDim, fontSize: 9, textTransform: "uppercase", fontWeight: "800", letterSpacing: 0.9 },
  metricValue: { color: colors.text, fontSize: 15, fontWeight: "900", marginTop: 7 },
  quantityCard: { marginTop: spacing.md, padding: spacing.xl, borderRadius: radius.xl, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderStrong },
  blockTitle: { color: colors.text, fontSize: 17, fontWeight: "900" },
  blockCopy: { color: colors.textMuted, fontSize: 12, lineHeight: 19, marginTop: 5 },
  estimate: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", paddingVertical: spacing.xl },
  estimateLabel: { color: colors.textDim, fontSize: 9, fontWeight: "800", letterSpacing: 1 },
  estimateValue: { color: colors.primary, fontSize: 24, fontWeight: "900", marginTop: 5 },
  impactValue: { color: colors.text, fontSize: 17, fontWeight: "900", marginTop: 5 },
  warning: { color: "#f0b45d", fontSize: 11, lineHeight: 17, marginBottom: spacing.md },
  transparencyCard: { flexDirection: "row", gap: spacing.md, marginVertical: spacing.md, padding: spacing.lg, borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  transparencyIcon: { width: 46, height: 46, borderRadius: 15, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(123,167,255,.1)" },
  evidence: { color: colors.textDim, fontSize: 10, lineHeight: 16, marginTop: 6 },
});
