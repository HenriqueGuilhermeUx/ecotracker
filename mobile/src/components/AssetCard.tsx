import { MaterialCommunityIcons } from "@expo/vector-icons";
import { StyleSheet, Text, View } from "react-native";
import type { Asset } from "../types";
import { colors, radius, shadow, spacing, typography } from "../theme";
import { ScalePressable, StatusPill } from "./ui";

const money = (value?: string | null) => {
  const number = Number(value);
  return Number.isFinite(number)
    ? number.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 4 })
    : null;
};

const number = (value?: string | null, digits = 2) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toLocaleString("pt-BR", { maximumFractionDigits: digits }) : null;
};

export function AssetCard({ asset, onPress, compact = false }: { asset: Asset; onPress: () => void; compact?: boolean }) {
  const price = money(asset.indicative_price_brl_kg);
  const tons = number(asset.available_tons, 3);
  const isLive = asset.source_status === "connected";
  const verifiedOffset = asset.claim_category === "voluntary_offset" && asset.eligibility_status === "eligible";
  const contribution = asset.claim_category === "climate_contribution" || asset.claim_category === "ecological_contribution";
  const isCarbonmark = asset.monitor_details?.providerKey === "carbonmark" || asset.source_reference.startsWith("carbonmark-");
  const fractional = Boolean(asset.fractional_retirement_supported) && Number(asset.retirement_granularity_kg || 1000) <= 1;
  const label = verifiedOffset ? "COMPENSAÇÃO VERIFICADA" : contribution ? "CONTRIBUIÇÃO" : "USO RESTRITO";

  return (
    <ScalePressable onPress={onPress} style={[styles.card, compact && styles.compact]}>
      <View style={styles.topRow}>
        <View style={[styles.sourceIcon, isLive && styles.sourceIconLive]}>
          <MaterialCommunityIcons name={verifiedOffset ? "shield-check" : asset.asset_type.includes("removal") ? "tree" : "leaf-circle"} size={22} color={isLive || verifiedOffset ? colors.primary : colors.textMuted} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.registry}>{asset.registry}</Text>
          <Text style={styles.tier}>{isCarbonmark ? `Carbonmark ${asset.monitor_details?.environment || "API"}` : asset.quality_tier}</Text>
        </View>
        <StatusPill value={asset.source_status} />
      </View>

      <View style={styles.badgesRow}>
        <View style={[styles.claimBadge, verifiedOffset ? styles.claimVerified : contribution ? styles.claimContribution : styles.claimRestricted]}>
          <MaterialCommunityIcons name={verifiedOffset ? "check-decagram" : contribution ? "leaf" : "alert-outline"} size={13} color={verifiedOffset ? colors.primary : colors.textMuted} />
          <Text style={[styles.claimText, verifiedOffset && { color: colors.primary }]}>{label}</Text>
        </View>
        {isCarbonmark ? <View style={styles.sourceBadge}><Text style={styles.sourceBadgeText}>CARBONMARK</Text></View> : null}
        {fractional ? <View style={styles.sourceBadge}><Text style={styles.sourceBadgeText}>DESDE 1 KG</Text></View> : null}
      </View>

      <Text style={[styles.title, compact && { fontSize: 19 }]} numberOfLines={2}>{asset.project_name}</Text>
      {!compact ? <Text style={styles.description} numberOfLines={3}>{asset.description || "Ativo ambiental monitorado pelo EcoTracker."}</Text> : null}

      <View style={styles.metrics}>
        <View style={styles.metric}>
          <Text style={styles.metricLabel}>{isCarbonmark ? "Preço final" : "Preço de referência"}</Text>
          <Text style={styles.metricValue}>{isCarbonmark ? "Cotação ao vivo" : price ? price : "Sob consulta"}</Text>
        </View>
        <View style={styles.metric}>
          <Text style={styles.metricLabel}>Disponibilidade</Text>
          <Text style={styles.metricValue}>{tons ? `${tons} t` : "Confirmar"}</Text>
        </View>
      </View>

      <View style={styles.footer}>
        <View style={styles.unit}><Text style={styles.unitText}>{verifiedOffset ? "Preço travado antes de pagar" : "1 ECOT = 1 kg CO₂e alocado"}</Text></View>
        <MaterialCommunityIcons name="arrow-right" size={20} color={colors.primary} />
      </View>
    </ScalePressable>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: radius.xl, borderWidth: 1, borderColor: colors.border, padding: spacing.xl, gap: spacing.lg, ...shadow },
  compact: { width: 285, minHeight: 260, marginRight: spacing.md },
  topRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  sourceIcon: { width: 44, height: 44, borderRadius: 14, backgroundColor: colors.surfaceStrong, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border },
  sourceIconLive: { backgroundColor: colors.primaryMuted, borderColor: colors.borderStrong },
  registry: { color: colors.text, fontSize: 13, fontWeight: "800" },
  tier: { color: colors.textDim, fontSize: 10, textTransform: "uppercase", letterSpacing: 1, marginTop: 2 },
  badgesRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  claimBadge: { alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 6, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 6, borderWidth: 1 },
  claimVerified: { backgroundColor: colors.primaryMuted, borderColor: colors.borderStrong },
  claimContribution: { backgroundColor: colors.backgroundRaised, borderColor: colors.border },
  claimRestricted: { backgroundColor: colors.surfaceStrong, borderColor: colors.border },
  claimText: { color: colors.textMuted, fontSize: 9, fontWeight: "900", letterSpacing: 0.6 },
  sourceBadge: { alignSelf: "flex-start", borderRadius: radius.pill, paddingHorizontal: 9, paddingVertical: 6, backgroundColor: colors.backgroundRaised, borderWidth: 1, borderColor: colors.border },
  sourceBadgeText: { color: colors.textMuted, fontSize: 8, fontWeight: "900", letterSpacing: 0.7 },
  title: { color: colors.text, fontSize: typography.heading, fontWeight: "800", letterSpacing: -0.5, lineHeight: 27 },
  description: { color: colors.textMuted, fontSize: 13, lineHeight: 20 },
  metrics: { flexDirection: "row", gap: spacing.sm },
  metric: { flex: 1, backgroundColor: colors.backgroundRaised, borderRadius: radius.md, padding: spacing.md, borderWidth: 1, borderColor: colors.border },
  metricLabel: { color: colors.textDim, fontSize: 9, textTransform: "uppercase", fontWeight: "700", letterSpacing: 0.8 },
  metricValue: { color: colors.text, fontSize: 14, fontWeight: "800", marginTop: 6 },
  footer: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  unit: { backgroundColor: colors.primaryMuted, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 6 },
  unitText: { color: colors.primary, fontSize: 10, fontWeight: "800" },
});
