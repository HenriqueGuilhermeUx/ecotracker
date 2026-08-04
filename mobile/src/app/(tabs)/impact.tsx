import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { QuantityStepper, SegmentedControl } from "../../components/forms";
import { Eyebrow, PrimaryButton, Screen } from "../../components/ui";
import { useApp } from "../../context/AppContext";
import { colors, radius, shadow, spacing, typography } from "../../theme";
import type { FootprintInput } from "../../types";

type Mode = "corporate" | "personal";

export default function ImpactScreen() {
  const router = useRouter();
  const { updateRecommendation } = useApp();
  const [mode, setMode] = useState<Mode>("corporate");
  const [values, setValues] = useState<Record<Mode, FootprintInput>>({
    corporate: { people: 15, flights: 5, vehicles: 3 },
    personal: { people: 1, flights: 2, vehicles: 1 },
  });
  const [saved, setSaved] = useState(false);

  const current = values[mode];
  const footprintKg = useMemo(() => current.people * 400 + current.flights * 150 + current.vehicles * 2400, [current]);
  const tons = footprintKg / 1000;

  function update(key: keyof FootprintInput, value: number) {
    setSaved(false);
    setValues((previous) => ({ ...previous, [mode]: { ...previous[mode], [key]: value } }));
  }

  async function apply() {
    await updateRecommendation(footprintKg);
    setSaved(true);
  }

  return (
    <Screen contentStyle={{ paddingTop: spacing.md }}>
      <Eyebrow>ESTIME E NEUTRALIZE</Eyebrow>
      <Text style={styles.title}>Sua pegada em uma medida simples.</Text>
      <Text style={styles.subtitle}>Use uma estimativa inicial para descobrir quantos ECOT podem ser necessários. Inventários oficiais exigem metodologia e dados específicos.</Text>

      <View style={{ marginTop: spacing.xxl }}>
        <SegmentedControl
          value={mode}
          onChange={setMode}
          options={[
            { value: "corporate", label: "Empresa", icon: "office-building-outline" },
            { value: "personal", label: "Pessoal", icon: "account-outline" },
          ]}
        />
      </View>

      <View style={styles.calculatorCard}>
        <View style={styles.cardHeader}>
          <View>
            <Text style={styles.cardEyebrow}>{mode === "corporate" ? "PEGADA CORPORATIVA" : "PEGADA PESSOAL"}</Text>
            <Text style={styles.cardTitle}>Estimativa anual</Text>
          </View>
          <View style={styles.yearBadge}><Text style={styles.yearText}>12 MESES</Text></View>
        </View>

        <QuantityStepper
          label={mode === "corporate" ? "Funcionários" : "Pessoas"}
          helper="400 kg CO₂e por pessoa/ano"
          value={current.people}
          onChange={(value) => update("people", value)}
        />
        <QuantityStepper
          label="Voos"
          helper="150 kg CO₂e por voo"
          value={current.flights}
          onChange={(value) => update("flights", value)}
        />
        <QuantityStepper
          label="Veículos"
          helper="2.400 kg CO₂e por veículo/ano"
          value={current.vehicles}
          onChange={(value) => update("vehicles", value)}
        />

        <View style={styles.result}>
          <Text style={styles.resultLabel}>PEGADA ESTIMADA</Text>
          <Text style={styles.resultValue}>{tons.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <Text style={styles.resultUnit}>tCO₂e</Text></Text>
          <Text style={styles.resultDetail}>{footprintKg.toLocaleString("pt-BR")} kg CO₂e · recomendação de {footprintKg.toLocaleString("pt-BR")} ECOT</Text>
        </View>

        <PrimaryButton title={saved ? "Recomendação salva" : "Aplicar recomendação"} icon={saved ? "check-circle-outline" : "target"} onPress={() => void apply()} />
        <View style={{ height: spacing.sm }} />
        <PrimaryButton title="Ver ativos compatíveis" icon="arrow-right" secondary onPress={() => router.push("/(tabs)/market")} />
      </View>

      <View style={styles.explainCard}>
        <View style={styles.explainIcon}><MaterialCommunityIcons name="information-outline" size={22} color={colors.blue} /></View>
        <View style={{ flex: 1 }}>
          <Text style={styles.explainTitle}>Como ler o resultado</Text>
          <Text style={styles.explainCopy}>1 ECOT representa 1 kg de CO₂e alocado. 1.000 ECOT equivalem a 1 tCO₂e vinculada a um crédito ou aposentadoria identificada.</Text>
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { color: colors.text, fontSize: typography.title, fontWeight: "900", letterSpacing: -1.1, lineHeight: 34, marginTop: spacing.sm },
  subtitle: { color: colors.textMuted, fontSize: 14, lineHeight: 22, marginTop: spacing.sm },
  calculatorCard: { marginTop: spacing.lg, padding: spacing.xl, borderRadius: radius.xl, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderStrong, ...shadow },
  cardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingBottom: spacing.lg, borderBottomWidth: 1, borderBottomColor: colors.border },
  cardEyebrow: { color: colors.primary, fontSize: 9, fontWeight: "900", letterSpacing: 1.4 },
  cardTitle: { color: colors.text, fontSize: typography.subheading, fontWeight: "800", marginTop: 5 },
  yearBadge: { paddingHorizontal: 10, paddingVertical: 7, borderRadius: radius.pill, backgroundColor: colors.primaryMuted },
  yearText: { color: colors.primary, fontSize: 9, fontWeight: "900" },
  result: { paddingVertical: spacing.xxl },
  resultLabel: { color: colors.textDim, fontSize: 9, fontWeight: "900", letterSpacing: 1.3 },
  resultValue: { color: colors.primary, fontSize: 38, fontWeight: "900", letterSpacing: -1.5, marginTop: 7 },
  resultUnit: { color: colors.text, fontSize: 17, letterSpacing: 0 },
  resultDetail: { color: colors.textMuted, fontSize: 12, lineHeight: 18, marginTop: 4 },
  explainCard: { flexDirection: "row", gap: spacing.md, marginTop: spacing.lg, padding: spacing.lg, borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  explainIcon: { width: 42, height: 42, borderRadius: 13, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(123,167,255,.1)" },
  explainTitle: { color: colors.text, fontSize: 14, fontWeight: "800" },
  explainCopy: { color: colors.textMuted, fontSize: 11, lineHeight: 17, marginTop: 4 },
});
