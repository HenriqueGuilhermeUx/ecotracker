import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { getQuote } from "../../api";
import { EmptyState, Eyebrow, LoadingBlock, PrimaryButton, ScalePressable, Screen, StatusPill } from "../../components/ui";
import { useApp } from "../../context/AppContext";
import { colors, radius, spacing, typography } from "../../theme";
import type { Quote } from "../../types";

const money = (value?: string | null) => value == null ? "Em análise" : Number(value).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

export default function ActivityScreen() {
  const router = useRouter();
  const { quoteCodes, removeQuote } = useApp();
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (refresh = false) => {
    refresh ? setRefreshing(true) : setLoading(true);
    const results = await Promise.allSettled(quoteCodes.map((code) => getQuote(code)));
    setQuotes(results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []));
    setLoading(false);
    setRefreshing(false);
  }, [quoteCodes]);

  useEffect(() => { void load(); }, [load]);

  return (
    <Screen refreshing={refreshing} onRefresh={() => void load(true)} contentStyle={{ paddingTop: spacing.md }}>
      <Eyebrow>MINHAS OPERAÇÕES</Eyebrow>
      <Text style={styles.title}>Acompanhe cada etapa.</Text>
      <Text style={styles.subtitle}>Pagamento, aquisição, aposentadoria, entrega e documentos em uma única timeline.</Text>

      {loading ? <LoadingBlock label="Atualizando suas operações..." /> : null}

      {!loading && quoteCodes.length === 0 ? (
        <View style={{ marginTop: spacing.xxxl }}>
          <EmptyState
            icon="timeline-plus-outline"
            title="Nenhuma operação ainda"
            message="Solicite uma cotação no marketplace. O código será salvo automaticamente neste aparelho."
            action={<PrimaryButton title="Abrir mercado" icon="leaf-circle-outline" onPress={() => router.push("/(tabs)/market")} />}
          />
        </View>
      ) : null}

      <View style={styles.list}>
        {quotes.map((quote) => (
          <ScalePressable
            key={quote.public_code}
            onPress={() => router.push({ pathname: "/quote/[code]", params: { code: quote.public_code } })}
            style={styles.card}
          >
            <View style={styles.cardTop}>
              <StatusPill value={quote.status} />
              <Text style={styles.date}>{new Date(quote.created_at).toLocaleDateString("pt-BR")}</Text>
            </View>
            <Text style={styles.project}>{quote.project_name}</Text>
            <Text style={styles.registry}>{quote.registry}</Text>
            <View style={styles.metrics}>
              <View><Text style={styles.metricLabel}>QUANTIDADE</Text><Text style={styles.metricValue}>{Number(quote.requested_kg).toLocaleString("pt-BR")} ECOT</Text></View>
              <View><Text style={styles.metricLabel}>VALOR</Text><Text style={styles.metricValue}>{money(quote.final_total)}</Text></View>
            </View>
            <View style={styles.cardFooter}>
              <Text style={styles.code} numberOfLines={1}>{quote.public_code}</Text>
              <MaterialCommunityIcons name="chevron-right" size={22} color={colors.primary} />
            </View>
          </ScalePressable>
        ))}
      </View>

      {!loading && quoteCodes.length > quotes.length ? (
        <View style={styles.warning}>
          <MaterialCommunityIcons name="cloud-alert-outline" size={20} color={colors.amber} />
          <Text style={styles.warningText}>Algumas operações não responderam agora. Puxe para atualizar novamente.</Text>
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { color: colors.text, fontSize: typography.title, fontWeight: "900", letterSpacing: -1.1, lineHeight: 34, marginTop: spacing.sm },
  subtitle: { color: colors.textMuted, fontSize: 14, lineHeight: 22, marginTop: spacing.sm },
  list: { gap: spacing.md, marginTop: spacing.xxxl },
  card: { padding: spacing.xl, borderRadius: radius.xl, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  cardTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  date: { color: colors.textDim, fontSize: 11 },
  project: { color: colors.text, fontSize: 19, fontWeight: "900", letterSpacing: -0.4, marginTop: spacing.lg },
  registry: { color: colors.textMuted, fontSize: 12, marginTop: 4 },
  metrics: { flexDirection: "row", gap: spacing.xl, marginTop: spacing.xl, paddingTop: spacing.lg, borderTopWidth: 1, borderTopColor: colors.border },
  metricLabel: { color: colors.textDim, fontSize: 9, fontWeight: "800", letterSpacing: 1 },
  metricValue: { color: colors.text, fontSize: 14, fontWeight: "800", marginTop: 5 },
  cardFooter: { flexDirection: "row", alignItems: "center", marginTop: spacing.lg },
  code: { flex: 1, color: colors.textDim, fontSize: 9 },
  warning: { flexDirection: "row", gap: spacing.sm, alignItems: "center", padding: spacing.lg, marginTop: spacing.lg, borderRadius: radius.md, backgroundColor: "rgba(245,198,106,.08)", borderWidth: 1, borderColor: "rgba(245,198,106,.25)" },
  warningText: { flex: 1, color: colors.amber, fontSize: 11, lineHeight: 16 },
});
