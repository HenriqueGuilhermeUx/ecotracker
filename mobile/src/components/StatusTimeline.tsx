import { MaterialCommunityIcons } from "@expo/vector-icons";
import { StyleSheet, Text, View } from "react-native";
import type { Quote } from "../types";
import { colors, spacing } from "../theme";

const steps = [
  { key: "payment", label: "Pagamento", icon: "credit-card-check-outline" as const },
  { key: "sourcing", label: "Aquisição", icon: "cart-arrow-down" as const },
  { key: "retirement", label: "Aposentadoria", icon: "leaf-circle-outline" as const },
  { key: "delivery", label: "Entrega ECOT", icon: "wallet-outline" as const },
];

const complete = (value?: string | null) => ["paid", "acquired", "retired", "delivered", "completed", "issued"].includes(String(value));
const active = (value?: string | null) => ["pending", "queued", "processing", "sourcing", "awaiting_payment", "awaiting_configuration"].includes(String(value));

export function StatusTimeline({ quote }: { quote: Quote }) {
  const values: Record<string, string | null | undefined> = {
    payment: quote.payment_status,
    sourcing: quote.sourcing_status,
    retirement: quote.retirement_status,
    delivery: quote.delivery_status,
  };

  return (
    <View style={styles.timeline}>
      {steps.map((step, index) => {
        const value = values[step.key] || "not_started";
        const done = complete(value);
        const running = active(value);
        return (
          <View key={step.key} style={styles.row}>
            <View style={styles.railWrap}>
              <View style={[styles.node, done && styles.nodeDone, running && !done && styles.nodeRunning]}>
                <MaterialCommunityIcons name={done ? "check" : step.icon} size={18} color={done ? colors.background : running ? colors.amber : colors.textDim} />
              </View>
              {index < steps.length - 1 ? <View style={[styles.rail, done && styles.railDone]} /> : null}
            </View>
            <View style={styles.copy}>
              <Text style={[styles.label, done && { color: colors.primary }]}>{step.label}</Text>
              <Text style={[styles.value, running && { color: colors.amber }]}>{String(value).replaceAll("_", " ")}</Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  timeline: { paddingVertical: spacing.sm },
  row: { flexDirection: "row", minHeight: 72 },
  railWrap: { width: 42, alignItems: "center" },
  node: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: colors.backgroundRaised, borderWidth: 1, borderColor: colors.border },
  nodeDone: { backgroundColor: colors.primary, borderColor: colors.primary },
  nodeRunning: { borderColor: colors.amber, backgroundColor: "rgba(245,198,106,.08)" },
  rail: { flex: 1, width: 2, backgroundColor: colors.border, marginVertical: 4 },
  railDone: { backgroundColor: colors.primary },
  copy: { flex: 1, paddingLeft: spacing.md, paddingTop: 7 },
  label: { color: colors.text, fontSize: 15, fontWeight: "800" },
  value: { color: colors.textDim, fontSize: 11, textTransform: "uppercase", marginTop: 4 },
});
