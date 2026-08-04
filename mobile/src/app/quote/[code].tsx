import { MaterialCommunityIcons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useCallback, useEffect, useState } from "react";
import { Alert, Image, StyleSheet, Text, View } from "react-native";
import { createCheckout, getQuote, receiptUrl } from "../../api";
import { StatusTimeline } from "../../components/StatusTimeline";
import { EmptyState, Eyebrow, LoadingBlock, PrimaryButton, ScalePressable, Screen, StatusPill } from "../../components/ui";
import { useApp } from "../../context/AppContext";
import { colors, radius, shadow, spacing, typography } from "../../theme";
import type { Checkout, Quote } from "../../types";

const money = (value?: string | null) => value == null ? "Em análise" : Number(value).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const done = (quote?: Quote | null) => quote?.status === "delivered" || quote?.status === "cancelled";

export default function QuoteDetailScreen() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const { addQuote } = useApp();
  const [quote, setQuote] = useState<Quote | null>(null);
  const [checkout, setCheckout] = useState<Checkout | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [paying, setPaying] = useState<"pix" | "card" | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true);
    setError("");
    try {
      const data = await getQuote(String(code));
      setQuote(data);
      await addQuote(data.public_code);
    } catch (nextError) {
      setError((nextError as Error).message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [addQuote, code]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!quote || done(quote)) return;
    const interval = setInterval(() => void load(true), 10000);
    return () => clearInterval(interval);
  }, [load, quote]);

  async function pay(method: "pix" | "card") {
    setPaying(method);
    try {
      const result = await createCheckout(String(code), method);
      setCheckout(result);
      if (method === "card" && result.checkoutUrl) {
        await WebBrowser.openBrowserAsync(result.checkoutUrl);
        await load();
      } else {
        await load();
      }
    } catch (nextError) {
      Alert.alert("Pagamento indisponível", (nextError as Error).message);
    } finally {
      setPaying(null);
    }
  }

  async function copyPix() {
    const value = checkout?.pixBrCode || quote?.pix_br_code;
    if (!value) return;
    await Clipboard.setStringAsync(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  }

  if (loading) return <Screen><LoadingBlock label="Carregando sua operação..." /></Screen>;
  if (error || !quote) return <Screen><EmptyState icon="alert-circle-outline" title="Operação não encontrada" message={error || "Verifique o código da cotação."} /></Screen>;

  const pixCode = checkout?.pixBrCode || quote.pix_br_code;
  const qrCode = checkout?.qrCodeUrl || quote.pix_qr_code_url;
  const paymentUrl = checkout?.checkoutUrl || quote.payment_url;
  const canPay = ["quoted", "awaiting_payment"].includes(quote.status) && quote.payment_status !== "paid" && Boolean(quote.final_total);
  const paid = quote.payment_status === "paid";

  return (
    <Screen refreshing={refreshing} onRefresh={() => void load()}>
      <View style={styles.headerCard}>
        <View style={styles.headerTop}>
          <StatusPill value={quote.status} />
          <ScalePressable onPress={() => void load()} style={styles.refreshButton}>
            <MaterialCommunityIcons name="refresh" size={20} color={colors.primary} />
          </ScalePressable>
        </View>
        <Eyebrow>{quote.registry}</Eyebrow>
        <Text style={styles.title}>{quote.project_name}</Text>
        <View style={styles.amountRow}>
          <View><Text style={styles.amountLabel}>IMPACTO</Text><Text style={styles.amountValue}>{Number(quote.requested_kg).toLocaleString("pt-BR")} <Text style={styles.amountUnit}>ECOT</Text></Text></View>
          <View style={{ alignItems: "flex-end" }}><Text style={styles.amountLabel}>VALOR</Text><Text style={styles.priceValue}>{money(quote.final_total)}</Text></View>
        </View>
        <Text style={styles.code} numberOfLines={1}>{quote.public_code}</Text>
      </View>

      <View style={styles.timelineCard}>
        <Text style={styles.blockTitle}>Andamento da operação</Text>
        <Text style={styles.blockCopy}>Atualização automática a cada 10 segundos enquanto a jornada estiver em andamento.</Text>
        <StatusTimeline quote={quote} />
      </View>

      {!quote.final_total ? (
        <View style={styles.waitingCard}>
          <MaterialCommunityIcons name="clock-outline" size={26} color={colors.amber} />
          <View style={{ flex: 1 }}><Text style={styles.waitingTitle}>Preço em confirmação</Text><Text style={styles.waitingCopy}>A equipe está validando lote, preço e disponibilidade. Nenhuma cobrança está liberada.</Text></View>
        </View>
      ) : null}

      {canPay ? (
        <View style={styles.paymentCard}>
          <Text style={styles.blockTitle}>Escolha como pagar</Text>
          <Text style={styles.blockCopy}>O processamento da aquisição começa somente depois da confirmação do provedor.</Text>
          <View style={styles.paymentOptions}>
            <ScalePressable onPress={() => void pay("pix")} disabled={Boolean(paying)} style={styles.paymentOption}>
              <View style={styles.paymentIcon}><MaterialCommunityIcons name="qrcode" size={24} color={colors.primary} /></View>
              <View style={{ flex: 1 }}><Text style={styles.paymentTitle}>Pix</Text><Text style={styles.paymentCopy}>QR Code e Copia e Cola</Text></View>
              {paying === "pix" ? <LoadingMini /> : <MaterialCommunityIcons name="chevron-right" size={22} color={colors.primary} />}
            </ScalePressable>
            <ScalePressable onPress={() => void pay("card")} disabled={Boolean(paying)} style={styles.paymentOption}>
              <View style={styles.paymentIcon}><MaterialCommunityIcons name="credit-card-outline" size={24} color={colors.blue} /></View>
              <View style={{ flex: 1 }}><Text style={styles.paymentTitle}>Cartão</Text><Text style={styles.paymentCopy}>Checkout seguro Mercado Pago</Text></View>
              {paying === "card" ? <LoadingMini /> : <MaterialCommunityIcons name="chevron-right" size={22} color={colors.primary} />}
            </ScalePressable>
          </View>
        </View>
      ) : null}

      {pixCode && !paid ? (
        <View style={styles.pixCard}>
          <View style={styles.pixHeader}><View><Eyebrow>PIX GERADO</Eyebrow><Text style={styles.blockTitle}>Finalize no seu banco</Text></View><MaterialCommunityIcons name="qrcode-scan" size={28} color={colors.primary} /></View>
          {qrCode ? <Image source={{ uri: qrCode }} style={styles.qrCode} resizeMode="contain" /> : null}
          <Text style={styles.pixCode} numberOfLines={4}>{pixCode}</Text>
          <PrimaryButton title={copied ? "Código copiado" : "Copiar Pix Copia e Cola"} icon={copied ? "check" : "content-copy"} onPress={() => void copyPix()} />
        </View>
      ) : null}

      {paymentUrl && quote.payment_method === "card" && !paid ? (
        <View style={{ marginTop: spacing.md }}>
          <PrimaryButton title="Continuar pagamento no cartão" icon="open-in-new" onPress={() => void WebBrowser.openBrowserAsync(paymentUrl)} />
        </View>
      ) : null}

      {paid ? (
        <View style={styles.paidCard}>
          <View style={styles.paidIcon}><MaterialCommunityIcons name="check-decagram" size={28} color={colors.background} /></View>
          <View style={{ flex: 1 }}><Text style={styles.paidTitle}>Pagamento confirmado</Text><Text style={styles.paidCopy}>A aquisição está em processamento. Isso ainda não representa ECOT entregue.</Text></View>
        </View>
      ) : null}

      {quote.retirement_reference ? (
        <View style={styles.referenceCard}>
          <Text style={styles.referenceLabel}>REFERÊNCIA DE APOSENTADORIA</Text>
          <Text style={styles.referenceValue}>{quote.retirement_reference}</Text>
        </View>
      ) : null}

      {quote.receipt_status === "issued" ? (
        <View style={{ marginTop: spacing.md }}>
          <PrimaryButton title="Abrir recibo e comprovante" icon="file-document-check-outline" secondary onPress={() => void WebBrowser.openBrowserAsync(receiptUrl(quote.public_code))} />
        </View>
      ) : null}

      {quote.nfse_url ? (
        <View style={{ marginTop: spacing.sm }}>
          <PrimaryButton title="Abrir NFS-e" icon="receipt-text-check-outline" secondary onPress={() => void WebBrowser.openBrowserAsync(quote.nfse_url!)} />
        </View>
      ) : null}

      <View style={styles.securityNote}>
        <MaterialCommunityIcons name="shield-lock-outline" size={21} color={colors.textMuted} />
        <Text style={styles.securityText}>O app não recebe nem armazena dados do cartão. O pagamento ocorre no ambiente seguro do provedor.</Text>
      </View>
    </Screen>
  );
}

function LoadingMini() {
  return <MaterialCommunityIcons name="progress-clock" size={22} color={colors.amber} />;
}

const styles = StyleSheet.create({
  headerCard: { marginTop: spacing.sm, padding: spacing.xxl, borderRadius: radius.xl, backgroundColor: colors.surfaceStrong, borderWidth: 1, borderColor: colors.borderStrong, ...shadow },
  headerTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: spacing.xxl },
  refreshButton: { width: 40, height: 40, borderRadius: 13, alignItems: "center", justifyContent: "center", backgroundColor: colors.primaryMuted },
  title: { color: colors.text, fontSize: typography.heading, fontWeight: "900", letterSpacing: -0.7, lineHeight: 28, marginTop: spacing.sm },
  amountRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", marginTop: spacing.xxl },
  amountLabel: { color: colors.textDim, fontSize: 9, fontWeight: "900", letterSpacing: 1.2 },
  amountValue: { color: colors.primary, fontSize: 30, fontWeight: "900", letterSpacing: -1, marginTop: 4 },
  amountUnit: { color: colors.text, fontSize: 14, letterSpacing: 0 },
  priceValue: { color: colors.text, fontSize: 20, fontWeight: "900", marginTop: 5 },
  code: { color: colors.textDim, fontSize: 9, marginTop: spacing.xl },
  timelineCard: { marginTop: spacing.md, padding: spacing.xl, borderRadius: radius.xl, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  blockTitle: { color: colors.text, fontSize: 17, fontWeight: "900" },
  blockCopy: { color: colors.textMuted, fontSize: 11, lineHeight: 17, marginTop: 4 },
  waitingCard: { flexDirection: "row", gap: spacing.md, alignItems: "center", marginTop: spacing.md, padding: spacing.lg, borderRadius: radius.lg, backgroundColor: "rgba(245,198,106,.08)", borderWidth: 1, borderColor: "rgba(245,198,106,.25)" },
  waitingTitle: { color: colors.amber, fontSize: 14, fontWeight: "900" },
  waitingCopy: { color: colors.textMuted, fontSize: 11, lineHeight: 17, marginTop: 3 },
  paymentCard: { marginTop: spacing.md, padding: spacing.xl, borderRadius: radius.xl, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderStrong },
  paymentOptions: { gap: spacing.sm, marginTop: spacing.lg },
  paymentOption: { minHeight: 72, flexDirection: "row", alignItems: "center", gap: spacing.md, padding: spacing.md, borderRadius: radius.lg, backgroundColor: colors.backgroundRaised, borderWidth: 1, borderColor: colors.border },
  paymentIcon: { width: 46, height: 46, borderRadius: 15, alignItems: "center", justifyContent: "center", backgroundColor: colors.primaryMuted },
  paymentTitle: { color: colors.text, fontSize: 14, fontWeight: "900" },
  paymentCopy: { color: colors.textMuted, fontSize: 11, marginTop: 3 },
  pixCard: { marginTop: spacing.md, padding: spacing.xl, borderRadius: radius.xl, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderStrong },
  pixHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  qrCode: { width: 220, height: 220, alignSelf: "center", marginVertical: spacing.xl, backgroundColor: colors.white, borderRadius: radius.md },
  pixCode: { color: colors.textMuted, fontSize: 10, lineHeight: 15, padding: spacing.md, marginVertical: spacing.lg, borderRadius: radius.md, backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border },
  paidCard: { flexDirection: "row", gap: spacing.md, alignItems: "center", marginTop: spacing.md, padding: spacing.lg, borderRadius: radius.lg, backgroundColor: colors.primaryMuted, borderWidth: 1, borderColor: colors.borderStrong },
  paidIcon: { width: 48, height: 48, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: colors.primary },
  paidTitle: { color: colors.primary, fontSize: 15, fontWeight: "900" },
  paidCopy: { color: colors.textMuted, fontSize: 11, lineHeight: 17, marginTop: 3 },
  referenceCard: { marginTop: spacing.md, padding: spacing.lg, borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  referenceLabel: { color: colors.textDim, fontSize: 9, fontWeight: "900", letterSpacing: 1.1 },
  referenceValue: { color: colors.text, fontSize: 12, lineHeight: 18, marginTop: 7 },
  securityNote: { flexDirection: "row", gap: spacing.sm, alignItems: "center", justifyContent: "center", padding: spacing.xl, marginTop: spacing.lg },
  securityText: { flex: 1, color: colors.textDim, fontSize: 10, lineHeight: 15, textAlign: "center" },
});
