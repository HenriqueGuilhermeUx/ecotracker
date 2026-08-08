import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { getEligibilityCatalog } from "../../api";
import { AssetCard } from "../../components/AssetCard";
import { Chip, EmptyState, Eyebrow, LoadingBlock, Screen, SectionHeader } from "../../components/ui";
import { colors, radius, spacing, typography } from "../../theme";
import type { Asset, EligibilityCatalog } from "../../types";

type Shelf = "verified" | "contribution" | "restricted";

const EMPTY: EligibilityCatalog = { verifiedCompensation: [], climateContribution: [], restricted: [] };

export default function MarketScreen() {
  const router = useRouter();
  const [catalog, setCatalog] = useState<EligibilityCatalog>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [shelf, setShelf] = useState<Shelf>("verified");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");

  async function load(force = false) {
    force ? setRefreshing(true) : setLoading(true);
    setError("");
    try {
      const data = await getEligibilityCatalog();
      setCatalog(data || EMPTY);
    } catch (nextError) {
      setError((nextError as Error).message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => { void load(); }, []);

  const current = shelf === "verified"
    ? catalog.verifiedCompensation
    : shelf === "contribution" ? catalog.climateContribution : catalog.restricted;

  const filtered = useMemo(() => current.filter((asset) => {
    const haystack = `${asset.registry} ${asset.project_name} ${asset.description || ""} ${asset.vintage || ""}`.toLowerCase();
    return !search.trim() || haystack.includes(search.trim().toLowerCase());
  }), [current, search]);

  const verifiedCount = catalog.verifiedCompensation.length;
  const fractionalCount = catalog.verifiedCompensation.filter((asset) => asset.fractional_retirement_supported).length;

  return (
    <Screen refreshing={refreshing} onRefresh={() => void load(true)} contentStyle={{ paddingTop: spacing.md }}>
      <Eyebrow>MERCADO ECOTRACKER</Eyebrow>
      <Text style={styles.title}>Compense com lastro verificável.</Text>
      <Text style={styles.subtitle}>A prateleira principal mostra apenas lotes aprovados para compensação voluntária. Ativos de contribuição climática ficam separados e nunca são apresentados como offset.</Text>

      <View style={styles.integrityCard}>
        <View style={styles.integrityIcon}><MaterialCommunityIcons name="shield-check" size={26} color={colors.primary} /></View>
        <View style={{ flex: 1 }}>
          <Text style={styles.integrityTitle}>{verifiedCount} lote{verifiedCount === 1 ? "" : "s"} de compensação verificada</Text>
          <Text style={styles.integrityCopy}>{fractionalCount > 0 ? `${fractionalCount} com aposentadoria fracionária habilitada.` : "Nenhuma fonte fracionária habilitada neste momento; compras em kg ficam bloqueadas até existir uma fonte compatível."}</Text>
        </View>
      </View>

      <View style={styles.searchWrap}>
        <MaterialCommunityIcons name="magnify" size={21} color={colors.textDim} />
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Buscar registry, projeto ou vintage"
          placeholderTextColor={colors.textDim}
          selectionColor={colors.primary}
          style={styles.search}
        />
      </View>

      <View style={styles.filters}>
        <Chip label={`Compensação (${catalog.verifiedCompensation.length})`} active={shelf === "verified"} onPress={() => setShelf("verified")} />
        <Chip label={`Contribuição (${catalog.climateContribution.length})`} active={shelf === "contribution"} onPress={() => setShelf("contribution")} />
        <Chip label={`Restritos (${catalog.restricted.length})`} active={shelf === "restricted"} onPress={() => setShelf("restricted")} />
      </View>

      <SectionHeader
        title={shelf === "verified" ? "Compensação Verificada" : shelf === "contribution" ? "Contribuição Climática" : "Uso Restrito / Histórico"}
        subtitle={shelf === "verified"
          ? "Lotes com status registral, evidência, aposentadoria e validade comercial revisados."
          : shelf === "contribution"
            ? "Apoie impacto climático/ecológico sem afirmar compensação de emissões."
            : "Itens visíveis para transparência e histórico. Não são compráveis como compensação."}
      />

      {loading ? <LoadingBlock label="Validando elegibilidade dos lotes..." /> : null}
      {error ? <EmptyState icon="cloud-alert-outline" title="Não foi possível atualizar" message={error} /> : null}
      {!loading && !error && filtered.length === 0 ? (
        <EmptyState
          icon={shelf === "verified" ? "shield-alert-outline" : "leaf-off"}
          title={shelf === "verified" ? "Nenhum lote verificado disponível" : "Nenhum ativo nesta prateleira"}
          message={shelf === "verified" ? "O EcoTracker não substitui qualidade por disponibilidade. Uma nova fonte precisa ser validada antes de voltar à venda." : "Atualize o catálogo ou consulte outra prateleira."}
        />
      ) : null}

      <View style={styles.list}>
        {filtered.map((asset) => (
          <AssetCard
            key={asset.id}
            asset={asset}
            onPress={() => router.push({ pathname: "/asset/[id]", params: { id: String(asset.id), shelf } })}
          />
        ))}
      </View>

      <View style={styles.policyCard}>
        <MaterialCommunityIcons name="information-outline" size={22} color={colors.blue} />
        <Text style={styles.policyCopy}><Text style={styles.policyStrong}>Vintage não é “vencimento”. </Text>A data de validade exibida é a política comercial do EcoTracker. Um lote pode existir no registry e ainda assim ficar fora da prateleira de compensação por qualidade, claim, granularidade ou revisão desatualizada.</Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { color: colors.text, fontSize: typography.title, fontWeight: "900", letterSpacing: -1.1, lineHeight: 34, marginTop: spacing.sm },
  subtitle: { color: colors.textMuted, fontSize: 14, lineHeight: 22, marginTop: spacing.sm },
  integrityCard: { flexDirection: "row", gap: spacing.md, alignItems: "center", marginTop: spacing.xxl, padding: spacing.lg, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.surfaceStrong },
  integrityIcon: { width: 48, height: 48, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: colors.primaryMuted },
  integrityTitle: { color: colors.text, fontSize: 14, fontWeight: "900" },
  integrityCopy: { color: colors.textMuted, fontSize: 11, lineHeight: 17, marginTop: 4 },
  searchWrap: { flexDirection: "row", alignItems: "center", gap: spacing.sm, minHeight: 54, marginTop: spacing.xxl, paddingHorizontal: spacing.lg, borderRadius: radius.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  search: { flex: 1, color: colors.text, fontSize: 14 },
  filters: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginTop: spacing.md },
  list: { gap: spacing.md },
  policyCard: { flexDirection: "row", gap: spacing.md, marginTop: spacing.xl, padding: spacing.lg, borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  policyCopy: { flex: 1, color: colors.textMuted, fontSize: 11, lineHeight: 18 },
  policyStrong: { color: colors.text, fontWeight: "900" },
});
