import { MaterialCommunityIcons } from "@expo/vector-icons";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Field, SegmentedControl } from "../../components/forms";
import { Eyebrow, PrimaryButton, ScalePressable, Screen, SectionHeader } from "../../components/ui";
import { useApp } from "../../context/AppContext";
import { colors, radius, spacing, typography } from "../../theme";
import type { LocalProfile } from "../../types";

export default function ProfileScreen() {
  const { profile, updateProfile, quoteCodes } = useApp();
  const [form, setForm] = useState<LocalProfile>(profile);
  const [saved, setSaved] = useState(false);

  useEffect(() => setForm(profile), [profile]);

  function set<K extends keyof LocalProfile>(key: K, value: LocalProfile[K]) {
    setSaved(false);
    setForm((previous) => ({ ...previous, [key]: value }));
  }

  async function save() {
    await updateProfile(form);
    setSaved(true);
  }

  return (
    <Screen contentStyle={{ paddingTop: spacing.md }}>
      <Eyebrow>CONTA ECOTRACKER</Eyebrow>
      <Text style={styles.title}>Seus dados, no seu aparelho.</Text>
      <Text style={styles.subtitle}>O perfil local agiliza novas cotações. Dados de pagamento nunca são armazenados pelo aplicativo.</Text>

      <View style={styles.identityCard}>
        <View style={styles.avatar}><Text style={styles.avatarText}>{form.name ? form.name.charAt(0).toUpperCase() : "E"}</Text></View>
        <View style={{ flex: 1 }}>
          <Text style={styles.identityName}>{form.name || "Configure seu perfil"}</Text>
          <Text style={styles.identityEmail}>{form.email || "Adicione seu e-mail"}</Text>
        </View>
        <View style={styles.quoteBadge}><Text style={styles.quoteBadgeValue}>{quoteCodes.length}</Text><Text style={styles.quoteBadgeLabel}>operações</Text></View>
      </View>

      <SectionHeader title="Dados para cotação" subtitle="Preenchidos automaticamente nas próximas solicitações." />
      <View style={styles.formCard}>
        <Field label="Nome completo" value={form.name} onChangeText={(value) => set("name", value)} placeholder="Seu nome" autoCapitalize="words" />
        <Field label="E-mail" value={form.email} onChangeText={(value) => set("email", value)} placeholder="voce@email.com" keyboardType="email-address" autoCapitalize="none" />
        <Field label="WhatsApp" value={form.phone} onChangeText={(value) => set("phone", value)} placeholder="(11) 99999-9999" keyboardType="phone-pad" />
        <Field label="Empresa" value={form.companyName} onChangeText={(value) => set("companyName", value)} placeholder="Opcional" />
        <Field label="CPF ou CNPJ" value={form.taxId} onChangeText={(value) => set("taxId", value)} placeholder="Opcional" keyboardType="number-pad" />
      </View>

      <SectionHeader title="Entrega preferida" subtitle="Você poderá alterar em cada compra." />
      <SegmentedControl
        value={form.preferredDelivery}
        onChange={(value) => set("preferredDelivery", value)}
        options={[
          { value: "email", label: "Conta por e-mail", icon: "email-outline" },
          { value: "wallet", label: "Carteira 0x", icon: "wallet-outline" },
        ]}
      />
      {form.preferredDelivery === "wallet" ? (
        <View style={{ marginTop: spacing.md }}>
          <Field label="Endereço Base" value={form.walletAddress} onChangeText={(value) => set("walletAddress", value)} placeholder="0x..." autoCapitalize="none" />
        </View>
      ) : null}

      <View style={{ marginTop: spacing.xxl }}>
        <PrimaryButton title={saved ? "Perfil salvo" : "Salvar preferências"} icon={saved ? "check-circle-outline" : "content-save-outline"} onPress={() => void save()} />
      </View>

      <SectionHeader title="Transparência" subtitle="Informações institucionais e regras da plataforma." />
      <View style={styles.linksCard}>
        <LinkRow icon="web" label="Site oficial" onPress={() => void WebBrowser.openBrowserAsync("https://ecotracker10.netlify.app")} />
        <LinkRow icon="file-document-outline" label="Termos e privacidade" onPress={() => void WebBrowser.openBrowserAsync("https://ecotracker10.netlify.app/#home")} />
        <LinkRow icon="shield-check-outline" label="Como protegemos o lastro" onPress={() => void WebBrowser.openBrowserAsync("https://ecotracker10.netlify.app/#marketplace")} />
      </View>

      <View style={styles.company}>
        <MaterialCommunityIcons name="leaf" size={18} color={colors.primary} />
        <Text style={styles.companyText}>Desenvolvido por Alternative Ventures Ltda · CNPJ 61.920.356/0001-38</Text>
      </View>
    </Screen>
  );
}

function LinkRow({ icon, label, onPress }: { icon: keyof typeof MaterialCommunityIcons.glyphMap; label: string; onPress: () => void }) {
  return (
    <ScalePressable onPress={onPress} style={styles.linkRow}>
      <View style={styles.linkIcon}><MaterialCommunityIcons name={icon} size={20} color={colors.primary} /></View>
      <Text style={styles.linkLabel}>{label}</Text>
      <MaterialCommunityIcons name="open-in-new" size={18} color={colors.textDim} />
    </ScalePressable>
  );
}

const styles = StyleSheet.create({
  title: { color: colors.text, fontSize: typography.title, fontWeight: "900", letterSpacing: -1.1, lineHeight: 34, marginTop: spacing.sm },
  subtitle: { color: colors.textMuted, fontSize: 14, lineHeight: 22, marginTop: spacing.sm },
  identityCard: { flexDirection: "row", alignItems: "center", gap: spacing.md, marginTop: spacing.xxl, padding: spacing.lg, borderRadius: radius.xl, backgroundColor: colors.surfaceStrong, borderWidth: 1, borderColor: colors.borderStrong },
  avatar: { width: 54, height: 54, borderRadius: 18, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" },
  avatarText: { color: colors.background, fontSize: 23, fontWeight: "900" },
  identityName: { color: colors.text, fontSize: 16, fontWeight: "900" },
  identityEmail: { color: colors.textMuted, fontSize: 11, marginTop: 4 },
  quoteBadge: { alignItems: "center", paddingLeft: spacing.md, borderLeftWidth: 1, borderLeftColor: colors.border },
  quoteBadgeValue: { color: colors.primary, fontSize: 20, fontWeight: "900" },
  quoteBadgeLabel: { color: colors.textDim, fontSize: 9 },
  formCard: { gap: spacing.lg, padding: spacing.lg, borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  linksCard: { borderRadius: radius.lg, overflow: "hidden", backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  linkRow: { minHeight: 64, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.lg, borderBottomWidth: 1, borderBottomColor: colors.border },
  linkIcon: { width: 38, height: 38, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: colors.primaryMuted },
  linkLabel: { flex: 1, color: colors.text, fontSize: 14, fontWeight: "700" },
  company: { flexDirection: "row", gap: spacing.sm, alignItems: "center", justifyContent: "center", marginTop: spacing.xxxl, paddingHorizontal: spacing.xl },
  companyText: { flex: 1, color: colors.textDim, fontSize: 10, lineHeight: 15, textAlign: "center" },
});
