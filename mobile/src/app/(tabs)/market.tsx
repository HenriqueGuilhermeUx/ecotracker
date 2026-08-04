import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { getAssets, refreshAssets } from "../../api";
import { AssetCard } from "../../components/AssetCard";
import { Chip, EmptyState, Eyebrow, LoadingBlock, Screen, SectionHeader } from "../../components/ui";
import { colors, radius, spacing, typography } from "../../theme";
import type { Asset } from "../../types";

type Filter = "all" | "live" | "removal" | "quote";

export default function MarketScreen() {
  const router = useRouter();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");

  async function load(force = false) {
    force ? setRefreshing(true) : setLoading(true);
    setError("");
    try {
      const data = force ? await refreshAssets() : await getAssets();
      setAssets(Array.isArray(data) ? data : []);
    } catch (nextError) {
      setError((nextError as Error).message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => { void load(); }, []);

  const filtered = useMemo(() => assets.filter((asset) => {
    const haystack = `${asset.registry} ${asset.project_name} ${asset.description || ""}`.toLowerCase();
    const matchesSearch = !search.trim() || haystack.includes(search.trim().toLowerCase());
    const matchesFilter = filter === "all"
      || (filter === "live" && asset.source_status === "connected")
      || (filter === "removal" && asset.asset_type.includes("removal"))
      || (filter === "quote" && asset.pricing_mode === "quote");
    return matchesSearch && matchesFilter;
  }), [assets, filter, search]);

  const liveCount = assets.filter((asset) => asset.source_status === "connected").length;

  return (
    <Screen refreshing={refreshing} onRefresh={() => void load(true)} contentStyle={{ paddingTop: spacing.md }}>
      <Eyebrow>ECOROUTER MARKETPLACE</Eyebrow>
      <Text style={styles.title}>Escolha a origem do seu impacto.</Text>
      <Text style={styles.subtitle}>Compare fontes monitoradas, preços indicativos e condições de aposentadoria antes de solicitar sua cotação.</Text>

      <View style={styles.liveCard}>
        <View style={styles.liveIcon}><MaterialCommunityIcons name="access-point" size={24} color={colors.primary} /></View>
        <View style={{ flex: 1 }}>
          <Text style={styles.liveTitle}>{liveCount} fonte{liveCount === 1 ? "" : "s"} conectada{liveCount === 1 ? "" : "s"}</Text>
          <Text style={styles.liveCopy}>Puxe a tela para baixo para atualizar ordens, volume e câmbio.</Text>
        </View>
      </View>

      <View style={styles.searchWrap}>
        <MaterialCommunityIcons name="magnify" size={21} color={colors.textDim} />
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Buscar registry ou projeto"
          placeholderTextColor={colors.textDim}
          selectionColor={colors.primary}
          style={styles.search}
        />
      </View>

      <View style={styles.filters}>
        <Chip label="Todos" active={filter === "all"} onPress={() => setFilter("all")} />
        <Chip label="Ao vivo" active={filter === "live"} onPress={() => setFilter("live")} />
        <Chip label="Remoção" active={filter === "removal"} onPress={() => setFilter("removal")} />
        <Chip label="Sob consulta" active={filter === "quote"} onPress={() => setFilter("quote")} />
      </View>

      <SectionHeader title={`${filtered.length} opções encontradas`} subtitle="Nenhum pagamento ocorre antes da confirmação executável da fonte." />

      {loading ? <LoadingBlock label="Lendo o mercado ambiental..." /> : null}
      {error ? <EmptyState icon="cloud-alert-outline" title="Não foi possível atualizar" message={error} /> : null}
      {!loading && !error && filtered.length === 0 ? <EmptyState icon="leaf-off" title="Nenhum ativo neste filtro" message="Tente outro termo ou atualize o mercado." /> : null}

      <View style={styles.list}>
        {filtered.map((asset) => (
          <AssetCard
            key={asset.id}
            asset={asset}
            onPress={() => router.push({ pathname: "/asset/[id]", params: { id: String(asset.id) } })}
          />
        ))}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { color: colors.text, fontSize: typography.title, fontWeight: "900", letterSpacing: -1.1, lineHeight: 34, marginTop: spacing.sm },
  subtitle: { color: colors.textMuted, fontSize: 14, lineHeight: 22, marginTop: spacing.sm },
  liveCard: { flexDirection: "row", gap: spacing.md, alignItems: "center", marginTop: spacing.xxl, padding: spacing.lg, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.surfaceStrong },
  liveIcon: { width: 46, height: 46, borderRadius: 15, alignItems: "center", justifyContent: "center", backgroundColor: colors.primaryMuted },
  liveTitle: { color: colors.text, fontSize: 14, fontWeight: "800" },
  liveCopy: { color: colors.textMuted, fontSize: 11, lineHeight: 16, marginTop: 3 },
  searchWrap: { flexDirection: "row", alignItems: "center", gap: spacing.sm, minHeight: 54, marginTop: spacing.xxl, paddingHorizontal: spacing.lg, borderRadius: radius.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  search: { flex: 1, color: colors.text, fontSize: 14 },
  filters: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginTop: spacing.md },
  list: { gap: spacing.md },
});
