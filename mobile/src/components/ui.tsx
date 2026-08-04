import { MaterialCommunityIcons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useRef, type ReactNode } from "react";
import {
  ActivityIndicator,
  Animated,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors, radius, shadow, spacing, typography } from "../theme";

export function Screen({
  children,
  scroll = true,
  refreshing,
  onRefresh,
  contentStyle,
}: {
  children: ReactNode;
  scroll?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  contentStyle?: StyleProp<ViewStyle>;
}) {
  const content = scroll ? (
    <ScrollView
      contentContainerStyle={[styles.screenContent, contentStyle]}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      refreshControl={onRefresh ? <RefreshControl refreshing={Boolean(refreshing)} onRefresh={onRefresh} tintColor={colors.primary} colors={[colors.primary]} /> : undefined}
    >
      {children}
    </ScrollView>
  ) : <View style={[styles.screenContent, { flex: 1 }, contentStyle]}>{children}</View>;

  return <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>{content}</SafeAreaView>;
}

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <View style={styles.logoRow}>
      <View style={[styles.logoMark, compact && { width: 32, height: 32, borderRadius: 10 }]}>
        <MaterialCommunityIcons name="leaf" color={colors.background} size={compact ? 18 : 22} />
      </View>
      <Text style={[styles.logoText, compact && { fontSize: 19 }]}><Text style={{ color: colors.primary }}>eco</Text>tracker</Text>
    </View>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <Text style={styles.eyebrow}>{children}</Text>;
}

export function SectionHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <View style={styles.sectionHeader}>
      <View style={{ flex: 1 }}>
        <Text style={styles.sectionTitle}>{title}</Text>
        {subtitle ? <Text style={styles.sectionSubtitle}>{subtitle}</Text> : null}
      </View>
      {action}
    </View>
  );
}

export function ScalePressable({
  children,
  onPress,
  style,
  disabled,
  haptic = true,
}: {
  children: ReactNode;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  disabled?: boolean;
  haptic?: boolean;
}) {
  const scale = useRef(new Animated.Value(1)).current;
  const animate = (value: number) => Animated.spring(scale, { toValue: value, useNativeDriver: true, speed: 28, bounciness: 4 }).start();

  return (
    <Pressable
      disabled={disabled}
      onPressIn={() => animate(0.97)}
      onPressOut={() => animate(1)}
      onPress={() => {
        if (haptic) void Haptics.selectionAsync();
        onPress?.();
      }}
    >
      <Animated.View style={[style, { transform: [{ scale }], opacity: disabled ? 0.45 : 1 }]}>{children}</Animated.View>
    </Pressable>
  );
}

export function PrimaryButton({
  title,
  onPress,
  icon,
  disabled,
  loading,
  secondary = false,
}: {
  title: string;
  onPress: () => void;
  icon?: keyof typeof MaterialCommunityIcons.glyphMap;
  disabled?: boolean;
  loading?: boolean;
  secondary?: boolean;
}) {
  return (
    <ScalePressable onPress={onPress} disabled={disabled || loading} style={[styles.button, secondary && styles.buttonSecondary]}>
      {loading ? <ActivityIndicator color={secondary ? colors.primary : colors.background} /> : (
        <>
          {icon ? <MaterialCommunityIcons name={icon} size={19} color={secondary ? colors.primary : colors.background} /> : null}
          <Text style={[styles.buttonText, secondary && { color: colors.primary }]}>{title}</Text>
        </>
      )}
    </ScalePressable>
  );
}

export function Chip({ label, active, onPress }: { label: string; active?: boolean; onPress?: () => void }) {
  return (
    <ScalePressable onPress={onPress} style={[styles.chip, active && styles.chipActive]} haptic={Boolean(onPress)}>
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </ScalePressable>
  );
}

export function StatusPill({ value }: { value: string }) {
  const normalized = String(value || "pending").toLowerCase();
  const positive = ["connected", "confirmed", "paid", "retired", "delivered", "issued", "completed", "quoted"].includes(normalized);
  const warning = ["pending", "monitoring", "processing", "queued", "requested", "reviewing", "awaiting_payment", "awaiting_configuration"].includes(normalized);
  return (
    <View style={[styles.statusPill, positive ? styles.statusPositive : warning ? styles.statusWarning : styles.statusNeutral]}>
      <View style={[styles.statusDot, { backgroundColor: positive ? colors.primary : warning ? colors.amber : colors.textDim }]} />
      <Text style={[styles.statusText, { color: positive ? colors.primary : warning ? colors.amber : colors.textMuted }]}>{normalized.replaceAll("_", " ")}</Text>
    </View>
  );
}

export function EmptyState({ icon, title, message, action }: { icon: keyof typeof MaterialCommunityIcons.glyphMap; title: string; message: string; action?: ReactNode }) {
  return (
    <View style={styles.empty}>
      <View style={styles.emptyIcon}><MaterialCommunityIcons name={icon} size={28} color={colors.primary} /></View>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyMessage}>{message}</Text>
      {action}
    </View>
  );
}

export function LoadingBlock({ label = "Sincronizando..." }: { label?: string }) {
  return <View style={styles.loading}><ActivityIndicator color={colors.primary} /><Text style={styles.loadingText}>{label}</Text></View>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  screenContent: { paddingHorizontal: spacing.xl, paddingBottom: 120, backgroundColor: colors.background, flexGrow: 1 },
  logoRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  logoMark: { width: 40, height: 40, borderRadius: 13, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" },
  logoText: { color: colors.text, fontSize: 23, fontWeight: "800", letterSpacing: -1 },
  eyebrow: { color: colors.primary, fontSize: typography.micro, fontWeight: "800", letterSpacing: 1.8, textTransform: "uppercase" },
  sectionHeader: { flexDirection: "row", alignItems: "flex-end", gap: spacing.md, marginTop: spacing.xxxl, marginBottom: spacing.lg },
  sectionTitle: { color: colors.text, fontSize: typography.heading, fontWeight: "800", letterSpacing: -0.5 },
  sectionSubtitle: { color: colors.textMuted, fontSize: typography.caption, lineHeight: 18, marginTop: 4 },
  button: { minHeight: 52, borderRadius: radius.md, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 9, paddingHorizontal: spacing.xl },
  buttonSecondary: { backgroundColor: colors.surfaceStrong, borderWidth: 1, borderColor: colors.borderStrong },
  buttonText: { color: colors.background, fontWeight: "800", fontSize: 15 },
  chip: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: radius.pill, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  chipActive: { backgroundColor: colors.primaryMuted, borderColor: colors.primary },
  chipText: { color: colors.textMuted, fontSize: 12, fontWeight: "700" },
  chipTextActive: { color: colors.primary },
  statusPill: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", borderRadius: radius.pill, borderWidth: 1, paddingHorizontal: 9, paddingVertical: 6 },
  statusPositive: { borderColor: "rgba(105,255,154,.3)", backgroundColor: "rgba(105,255,154,.08)" },
  statusWarning: { borderColor: "rgba(245,198,106,.3)", backgroundColor: "rgba(245,198,106,.08)" },
  statusNeutral: { borderColor: colors.border, backgroundColor: colors.surface },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusText: { fontSize: 10, fontWeight: "800", textTransform: "uppercase" },
  empty: { padding: spacing.xxxl, alignItems: "center", justifyContent: "center", borderRadius: radius.lg, borderWidth: 1, borderStyle: "dashed", borderColor: colors.borderStrong, backgroundColor: colors.surface, gap: spacing.md },
  emptyIcon: { width: 56, height: 56, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: colors.primaryMuted },
  emptyTitle: { color: colors.text, fontSize: typography.subheading, fontWeight: "800", textAlign: "center" },
  emptyMessage: { color: colors.textMuted, fontSize: typography.body, lineHeight: 22, textAlign: "center" },
  loading: { minHeight: 150, alignItems: "center", justifyContent: "center", gap: 12 },
  loadingText: { color: colors.textMuted, fontSize: 13 },
});
