import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import { createQuote, getAssets } from "../../api";
import { Field, QuantityStepper, SegmentedControl } from "../../components/forms";
import { Chip, Eyebrow, LoadingBlock, PrimaryButton, Screen } from "../../components/ui";
import { useApp } from "../../context/AppContext";
import { colors, radius, spacing, typography } from "../../theme";
import type { Asset, QuoteRequest } from "../../types";

type Purpose = QuoteRequest["purpose"];

export default function NewQuoteScreen() {
  const { assetId, quantity } = useLocalSearchParams<{ assetId: string; quantity?: string }>();
  const router = useRouter();
  const { profile, addQuote } = useApp();
  const [asset, setAsset] = useState<Asset | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
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
    purpose: "neutralization",
  });

  useEffect(() => {
    getAssets().then((assets) => {
      const found = assets.find((item) => String(item.id) === String(assetId)) || null;
      setAsset(found);
      if (found) setForm((previous) => ({ ...previous, assetId: found.id, requestedKg: Math.max(found.min_order_kg || 1, previous.requestedKg) }));
    }).finally(() => setLoading(false));
  }, [assetId]);

  const estimate = useMemo(() => {
    const price = Number(asset?.indicative_price_brl_kg);
    return Number.isFinite(price) && price > 0 ? price * form.requestedKg : null;
  }, [asset, form.requestedKg]);

  function set<K extends keyof QuoteRequest>(key: K, value: QuoteRequest[K]) {
    setForm((previous) => ({ ...previous, [key]: value }));
  }

  function validate(): string | null {
    if (!form.buyerName.trim()) return "Informe seu nome.";
    if (!/^\S+@\S+\.\S+$/.test(form.buyerEmail.trim())) return "Informe um e-mail válido.";
    if (form.requestedKg < Number(asset?.min_order_kg || 1)) return `O pedido mínimo é ${asset?.min_order_kg} ECOT.`;
    if (form.deliveryMode === "wallet" && !/^0x[a-fA-F0-9]{40}$/.test(form.walletAddress || "")) return "Informe uma carteira 0x válida.";
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
      <Eyebrow>SOLICITAÇÃO PROTEGIDA</Eyebrow>
      <Text style={styles.title}>Confirme os detalhes.</Text>
      <Text style={styles.subtitle}>Você não será cobrado agora. A operação só avança após preço, volume e regras da fonte estarem confirmados.</Text>

      <View style={styles.assetSummary}>
        <View style={styles.assetIcon}><MaterialCommunityIcons name="leaf-circle-outline" size={26} color={colors.primary} /></View>
        <View style={{ flex: 1 }}><Text style={styles.assetRegistry}>{asset.registry}</Text><Text style={styles.assetName}>{asset.project_name}</Text></View>
      </View>

      <View style={styles.formCard}>
        <Text style={styles.blockTitle}>Quantidade</Text>
        <QuantityStepper label="ECOT" helper="1 ECOT = 1 kg CO₂e" value={form.requestedKg} min={asset.min_order_kg || 1} step={Math.max(1, asset.min_order_kg || 1)} onChange={(value) => set("requestedKg", value)} />
        <View style={styles.estimate}><Text style={styles.estimateLabel}>Estimativa atual</Text><Text style={styles.estimateValue}>{estimate == null ? "Sob consulta" : estimate.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</Text></View>
      </View>

      <Text style={styles.sectionTitle}>Finalidade</Text>
      <View style={styles.chips}>
        <Chip label="Neutralização" active={form.purpose === "neutralization"} onPress={() => set("purpose", "neutralization")} />
        <Chip label="EcoRewards" active={form.purpose === "rewards"} onPress={() => set("purpose", "rewards")} />
        <Chip label="Programa empresarial" active={form.purpose === "corporate"} onPress={() => set("purpose", "corporate")} />
        <Chip label="Outro" active={form.purpose === "other"} onPress={() => set("purpose", "other")} />
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
        <Text style={styles.disclaimerText}>O ECOT só será entregue depois da aquisição e aposentadoria do ativo ambiental. A posse de uma cotação não representa crédito adquirido.</Text>
      </View>

      <PrimaryButton title="Registrar solicitação" icon="check" loading={sending} onPress={() => void submit()} />
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
  formCard: { gap: spacing.lg, marginTop: spacing.md, padding: spacing.lg, borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  blockTitle: { color: colors.text, fontSize: 16, fontWeight: "900" },
  estimate: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingTop: spacing.md },
  estimateLabel: { color: colors.textMuted, fontSize: 12 },
  estimateValue: { color: colors.primary, fontSize: 20, fontWeight: "900" },
  sectionTitle: { color: colors.text, fontSize: 17, fontWeight: "900", marginTop: spacing.xxl, marginBottom: spacing.md },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  disclaimer: { flexDirection: "row", gap: spacing.md, alignItems: "flex-start", marginVertical: spacing.xxl, padding: spacing.lg, borderRadius: radius.md, backgroundColor: colors.primaryMuted, borderWidth: 1, borderColor: colors.borderStrong },
  disclaimerText: { flex: 1, color: colors.textMuted, fontSize: 11, lineHeight: 17 },
});
