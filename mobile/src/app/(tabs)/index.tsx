import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { getAssets } from "../../api";
import { AssetCard } from "../../components/AssetCard";
import { Eyebrow, Logo, PrimaryButton, ScalePressable, Screen, SectionHeader, StatusPill } from "../../components/ui";
import { useApp } from "../../context/AppContext";
import { colors, radius, shadow, spacing, typography } from "../../theme";
import type { Asset } from "../../types";

export default function HomeScreen() {
  const router = useRouter();
  const { profile, quoteCodes, recommendationKg } = useApp();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [online, setOnline] = useState(false);

  useEffect(() => {
    getAssets().then((data) => {
      setAssets(Array.isArray(data) ? data.slice(0, 5) : []);
      setOnline(true);
    }).catch(() => setOnline(false));
  }, []);

  const firstName = profile.name.trim().split(" ")[0];

  return (
    <Screen contentStyle={{ paddingTop: spacing.md }}>
      <View style={styles.header}>
        <Logo compact />
        <ScalePressable onPress={() => router.push("/(tabs)/profile")} style={styles.avatar}>
          <Text style={styles.avatarText}>{firstName ? firstName.charAt(0).toUpperCase() : "E"}</Text>
        </ScalePressable>
      </View>

      <View style={styles.welcome}>
        <Eyebrow>CARBON TOKENIZATION PROTOCOL</Eyebrow>
        <Text style={styles.greeting}>{firstName ? `Olá, ${firstName}.` : "Seu impacto começa aqui."}</Text>
        <Text style={styles.subtitle}>Calcule, adquira e acompanhe créditos ambientais fracionados com rastreabilidade até a aposentadoria.</Text>
      </View>

      <View style={styles.heroCard}>
        <View style={styles.heroTop}>
          <StatusPill value={online ? "connected" : "monitoring"} />
          <MaterialCommunityIcons name="shield-check-outline" size={24} color={colors.primary} />
        </View>
        <Text style={styles.heroLabel}>RECOMENDAÇÃO ATUAL</Text>
        <Text style={styles.heroValue}>{recommendationKg.toLocaleString("pt-BR")} <Text style={styles.heroUnit}>ECOT</Text></Text>
        <Text style={styles.heroExplain}>1 ECOT representa a alocação rastreável de 1 kg de CO₂e. A reivindicação ambiental é confirmada pela aposentadoria do crédito de origem.</Text>
        <View style={styles.heroActions}>
          <PrimaryButton title="Explorar ativos" icon="leaf-circle-outline" onPress={() => router.push("/(tabs)/market")} />
          <PrimaryButton title="Recalcular" icon="calculator-variant-outline" secondary onPress={() => router.push("/(tabs)/impact")} />
        </View>
      </View>

      <View style={styles.quickGrid}>
        <ScalePressable style={styles.quickCard} onPress={() => router.push("/(tabs)/activity")}>
          <MaterialCommunityIcons name="timeline-clock-outline" size={23} color={colors.blue} />
          <Text style={styles.quickValue}>{quoteCodes.length}</Text>
          <Text style={styles.quickLabel}>operações salvas</Text>
        </ScalePressable>
        <ScalePressable style={styles.quickCard} onPress={() => router.push("/(tabs)/market")}>
          <MaterialCommunityIcons name="access-point" size={23} color={colors.primary} />
          <Text style={styles.quickValue}>{assets.length}</Text>
          <Text style={styles.quickLabel}>fontes monitoradas</Text>
        </ScalePressable>
      </View>

      <SectionHeader title="Mercado monitorado" subtitle="Ativos conectados e canais de cotação sob demanda." />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingRight: spacing.xl }}>
        {assets.map((asset) => (
          <AssetCard
            key={asset.id}
            asset={asset}
            compact
            onPress={() => router.push({ pathname: "/asset/[id]", params: { id: String(asset.id) } })}
          />
        ))}
      </ScrollView>

      <SectionHeader title="Como funciona" subtitle="Uma jornada protegida antes de cada ECOT ser entregue." />
      <View style={styles.flowCard}>
        {[
          ["radar", "Monitoramento", "O EcoTracker acompanha preço, volume e condições da fonte."],
          ["cash-check", "Cotação", "Você recebe o preço final em reais antes de pagar."],
          ["leaf-circle", "Aposentadoria", "O crédito é adquirido e aposentado na origem."],
          ["wallet-check", "Entrega", "Os ECOT e o comprovante são vinculados à sua operação."],
        ].map(([iconName, title, copy], index) => (
          <View style={styles.flowRow} key={title}>
            <View style={styles.flowIcon}><MaterialCommunityIcons name={iconName as keyof typeof MaterialCommunityIcons.glyphMap} size={21} color={colors.primary} /></View>
            <View style={{ flex: 1 }}><Text style={styles.flowTitle}>{title}</Text><Text style={styles.flowCopy}>{copy}</Text></View>
            <Text style={styles.flowNumber}>0{index + 1}</Text>
          </View>
        ))}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: spacing.xxxl },
  avatar: { width: 40, height: 40, borderRadius: 14, backgroundColor: colors.surfaceStrong, borderWidth: 1, borderColor: colors.borderStrong, alignItems: "center", justifyContent: "center" },
  avatarText: { color: colors.primary, fontWeight: "900", fontSize: 17 },
  welcome: { gap: spacing.sm, marginBottom: spacing.xxl },
  greeting: { color: colors.text, fontSize: typography.title, fontWeight: "900", letterSpacing: -1 },
  subtitle: { color: colors.textMuted, fontSize: typography.body, lineHeight: 23 },
  heroCard: { borderRadius: radius.xl, padding: spacing.xxl, backgroundColor: colors.surfaceStrong, borderWidth: 1, borderColor: colors.borderStrong, ...shadow },
  heroTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  heroLabel: { color: colors.textDim, fontSize: 10, fontWeight: "800", letterSpacing: 1.4, marginTop: spacing.xxl },
  heroValue: { color: colors.primary, fontSize: 42, lineHeight: 50, fontWeight: "900", letterSpacing: -2 },
  heroUnit: { color: colors.text, fontSize: 18, letterSpacing: 0 },
  heroExplain: { color: colors.textMuted, fontSize: 12, lineHeight: 19, marginTop: spacing.sm },
  heroActions: { gap: spacing.sm, marginTop: spacing.xl },
  quickGrid: { flexDirection: "row", gap: spacing.md, marginTop: spacing.md },
  quickCard: { flex: 1, minHeight: 128, borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, padding: spacing.lg, justifyContent: "space-between" },
  quickValue: { color: colors.text, fontSize: 26, fontWeight: "900" },
  quickLabel: { color: colors.textMuted, fontSize: 11 },
  flowCard: { borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, overflow: "hidden" },
  flowRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, padding: spacing.lg, borderBottomWidth: 1, borderBottomColor: colors.border },
  flowIcon: { width: 42, height: 42, borderRadius: 13, alignItems: "center", justifyContent: "center", backgroundColor: colors.primaryMuted },
  flowTitle: { color: colors.text, fontSize: 14, fontWeight: "800" },
  flowCopy: { color: colors.textMuted, fontSize: 11, lineHeight: 17, marginTop: 3 },
  flowNumber: { color: colors.textDim, fontSize: 10, fontWeight: "800" },
});
