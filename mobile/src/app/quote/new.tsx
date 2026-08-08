import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import { createQuote, getAssets } from "../../api";
import { Field, QuantityStepper, SegmentedControl } from "../../components/forms";
import { Eyebrow, LoadingBlock, PrimaryButton, Screen } from "../../components/ui";
import { useApp } from "../../context/AppContext";
import { colors, radius, spacing, typography } from "../../theme";
import type { Asset, QuoteRequest } from "../../types";

export default function NewQuoteScreen() {
  const { assetId, quantity, purpose } = useLocalSearchParams<{ assetId: string; quantity?: string; purpose?: string }>();
  const router = useRouter();
  const { profile, addQuote } = useApp();
  const [asset, setAsset] = useState<Asset | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const initialPurpose: QuoteRequest["purpose"] = purpose === "climate_contribution" ? "climate_contribution" : "voluntary_offset";
  const [form, setForm] = useState<QuoteRequest>({
    assetId: Number(assetId),
    buyerName: profile.name,
    buyerEmail: profile.email,
    buyerPhone: profile.phone,
    companyName: profile.companyName,
    taxId: profile.taxId,
    requestedKg: Math.max(1, Number(quantity) || 100),
    deliveryMode: profile.preferredDelivery,
    walletAddress: profile.walletAddress,
    purpose: initialPurpose,
  });

  useEffect(() => {
    getAssets().then((assets) => {
      const found = assets.find((item) => String(item.id) === String(assetId)) || null;
      setAsset(found);
      if (found) {
        const verifiedOffset = found.claim_category === "voluntary_offset" && found.eligibility_status === "eligible";
        setForm((previous) => ({
          ...previous,
          assetId: found.id,
          requestedKg: Math.max(found.min_order_kg || 1, previous.requestedKg),
          purpose: verifiedOffset ? "voluntary_offset" : "climate_contribution",
        }));
      }
    }).finally(() => setLoading(false));
  }, [assetId]);

  const estimate = useMemo(() => {
    const price = Number(asset?.indicative_price_brl_kg);
    return Number.isFinite(price) && price > 0 ? price * form.requestedKg : null;
  }, [asset, form.requestedKg]);

  const verifiedOffset = asset?.claim_category === "voluntary_offset" && asset?.eligibility_status === "eligible";

  function set<K extends keyof QuoteRequest>(key: K, value: QuoteRequest[K]) {
    setForm((previous) => ({ ...previous, [key]: value }));
  }

  function validate(): string | null {
    if (!form.buyerName.trim()) return "Informe seu nome.";
    if (!/^\S+@\S+\.\S+$/.test(form.buyerEmail.trim())) return "Informe um e-mail válido.";
    if (form.requestedKg < Number(asset?.min_order_kg || 1)) return `O pedido mínimo é ${asset?.min_order_kg} ECOT.`;
    if (form.deliveryMode === "wallet" && !/^0x[a-fA-F0-9]{40}$/.test(form.walletAddress || "")) return "Informe uma carteira 0x válida.";
    if (verifiedOffset && !asset?.fractional_retirement_supported) {
      const granularity = Math.max(1, Number(asset?.retirement_granularity_kg || 1000));
      if (form.requestedKg % granularity !== 0) return `Este lote só permite aposentadoria em blocos de ${granularity.toLocaleString("pt-BR")} kg.`;
    }
    return null;
  }

  async function submit() {
    const error = validate();
    if (error) return Alert.alert("Revise a solicitação", error);
    setSending(true);
    try {
      const result = await createQuote({ ...form, walletAddress: form.deliveryMode === "wallet" ? form.walletAddress : undefined });
      await addQuote(result.public_code);
      router.replace({ pathname: "/quote/[code]", params: { code: result.public_code } });
    } catch (error) {
      Alert.alert("Não foi possível registrar", (error as Error).message);
    } finally {
      setSending(false);
    }
  }

  if (loading) return <Screen><LoadingBlock label="Preparando sua cotação..." /></Screen>;
  if (!asset) return <Screen><Text style={{ color: colors.text }}>Ativo não encontrado.</Text></Screen>;

  return (
    <Screen>
      <Eyebrow>{verifiedOffset ? "COMPENSAÇÃO VERIFICADA" : "CONTRIBUIÇÃO CLIMÁTICA"}</Eyebrow>
      <Text style={styles.title}>{verifiedOffset ? "Confirme sua compensação." : "Confirme sua contribuição."}</Text>
      <Text style={styles.subtitle}>{verifiedOffset ? "Você não será cobrado agora. O fluxo só avança se preço, volume, status registral e aposentadoria continuarem válidos." : "Este fluxo apoia impacto climático/ecológico sem afirmar que suas emissões foram compensadas."}</Text>

      <View style={styles.assetSummary}>
        <View style={styles.assetIcon}><MaterialCommunityIcons name={verifiedOffset ? "shield-check" : "leaf-circle-outline"} size={26} color={colors.primary} /></View>
        <View style={{ flex: 1 }}><Text style={styles.assetRegistry}>{asset.registry}</Text><Text style={styles.assetName}>{asset.project_name}</Text></View>
      </View>

      <View style={styles.claimBox}>
        <Text style={styles.claimLabel}>FINALIDADE FIXADA PELO LOTE</Text>
        <Text style={styles.claimValue}>{verifiedOffset ? "Compensação voluntária" : "Contribuição climática"}</Text>
        <Text style={styles.claimCopy}>{verifiedOffset ? "A operação precisa terminar em aposentadoria elegível e rastreável antes da entrega final." : "O comprovante usará linguagem de contribuição e não de neutralização/offset."}</Text>
      </View>

      <View style={styles.formCard}>
        <Text style={styles.blockTitle}>Quantidade</Text>
        <QuantityStepper label="ECOT" helper="1 ECOT = 1 kg CO₂e alocado" value={form.requestedKg} min={asset.min_order_kg || 1} step={Math.max(1, asset.min_order_kg || 1)} onChange={(value) => set("requestedKg", value)} />
        <View style={styles.estimate}><Text style={styles.estimateLabel}>Estimativa atual</Text><Text style={styles.estimateValue}>{estimate == null ? "Sob consulta" : estimate.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</Text></View>
      </View>

      <Text style={styles.sectionTitle}>Seus dados</Text>
      <View style={styles.formCard}>
        <Field label="Nome completo" value={form.buyerName} onChangeText={(value) => set("buyerName", value)} placeholder="Seu nome" autoCapitalize="words" />
        <Field label="E-mail" value={form.buyerEmail} onChangeText={(value) => set("buyerEmail", value)} placeholder="voce@email.com" keyboardType="email-address" autoCapitalize="none" />
        <Field label="WhatsApp" value={form.buyerPhone} onChangeText={(value) => set("buyerPhone", value)} placeholder="(11) 99999-9999" keyboardType="phone-pad" />
        <Field label="Empresa" value={form.companyName} onChangeText={(value) => set("companyName", value)} placeholder="Opcional" />
        <Field label="CPF ou CNPJ" value={form.taxId} onChangeText={(value) => set("taxId", value)} placeholder="Opcional" keyboardType="number-pad" />
      </View>

      <Text style={styles.sectionTitle}>Como deseja receber?</Text>
      <SegmentedControl
        value={form.deliveryMode}
        onChange={(value) => set("deliveryMode", value)}
        options={[
          { value: "email", label: "Conta por e-mail", icon: "email-outline" },
          { value: "wallet", label: "Carteira 0x", icon: "wallet-outline" },
        ]}
      />
      {form.deliveryMode === "wallet" ? (
        <View style={{ marginTop: spacing.md }}>
          <Field label="Endereço Base" value={form.walletAddress || ""} onChangeText={(value) => set("walletAddress", value)} placeholder="0x..." autoCapitalize="none" />
        </View>
      ) : null}

      <View style={styles.disclaimer}>
        <MaterialCommunityIcons name="shield-check-outline" size={21} color={colors.primary} />
        <Text style={styles.disclaimerText}>{verifiedOffset ? "O ECOT de compensação só será entregue depois da aquisição e aposentadoria do crédito elegível. Uma cotação ou pagamento isolado não significa compensação concluída." : "O ECOT de contribuição representa uma alocação rastreável de impacto e não deve ser usado para afirmar que emissões foram compensadas."}</Text>
      </View>

      <PrimaryButton title={verifiedOffset ? "Registrar compensação" : "Registrar contribuição"} icon="check" loading={sending} onPress={() => void submit()} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { color: colors.text, fontSize: typography.title, fontWeight: "900", letterSpacing: -1.1, lineHeight: 34, marginTop: spacing.sm },
  subtitle: { color: colors.textMuted, fontSize: 14, lineHeight: 22, marginTop: spacing.sm },
  assetSummary: { flexDirection: "row", alignItems: "center", gap: spacing.md, marginTop: spacing.xxl, padding: spacing.lg, borderRadius: radius.lg, backgroundColor: colors.surfaceStrong, borderWidth: 1, borderColor: colors.borderStrong },
  assetIcon: { width: 48, height: 48, borderRadius: 15, alignItems: "center", justifyContent: "center", backgroundColor: colors.primaryMuted },
  assetRegistry: { color: colors.primary, fontSize: 10, fontWeight: "900", textTransform: "uppercase", letterSpacing: 1 },
  assetName: { color: colors.text, fontSize: 15, fontWeight: "800", marginTop: 4 },
  claimBox: { marginTop: spacing.md, padding: spacing.lg, borderRadius: radius.lg, backgroundColor: colors.primaryMuted, borderWidth: 1, borderColor: colors.borderStrong },
  claimLabel: { color: colors.textDim, fontSize: 9, fontWeight: "900", letterSpacing: 1 },
  claimValue: { color: colors.text, fontSize: 18, fontWeight: "900", marginTop: 5 },
  claimCopy: { color: colors.textMuted, fontSize: 11, lineHeight: 18, marginTop: 5 },
  formCard: { gap: spacing.lg, marginTop: spacing.md, padding: spacing.lg, borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  blockTitle: { color: colors.text, fontSize: 16, fontWeight: "900" },
  estimate: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingTop: spacing.md },
  estimateLabel: { color: colors.textMuted, fontSize: 12 },
  estimateValue: { color: colors.primary, fontSize: 20, fontWeight: "900" },
  sectionTitle: { color: colors.text, fontSize: 17, fontWeight: "900", marginTop: spacing.xxl, marginBottom: spacing.md },
  disclaimer: { flexDirection: "row", gap: spacing.md, alignItems: "flex-start", marginVertical: spacing.xxl, padding: spacing.lg, borderRadius: radius.md, backgroundColor: colors.primaryMuted, borderWidth: 1, borderColor: colors.borderStrong },
  disclaimerText: { flex: 1, color: colors.textMuted, fontSize: 11, lineHeight: 17 },
});
