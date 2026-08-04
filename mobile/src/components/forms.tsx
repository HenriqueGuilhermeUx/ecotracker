import { MaterialCommunityIcons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { StyleSheet, Text, TextInput, View, type TextInputProps } from "react-native";
import { colors, radius, spacing } from "../theme";
import { ScalePressable } from "./ui";

export function Field({ label, error, ...props }: TextInputProps & { label: string; error?: string }) {
  return (
    <View style={styles.fieldWrap}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        {...props}
        placeholderTextColor={colors.textDim}
        selectionColor={colors.primary}
        style={[styles.input, props.multiline && styles.multiline, error && styles.inputError, props.style]}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string; icon?: keyof typeof MaterialCommunityIcons.glyphMap }>;
  onChange: (value: T) => void;
}) {
  return (
    <View style={styles.segmented}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <ScalePressable
            key={option.value}
            onPress={() => onChange(option.value)}
            style={[styles.segment, active && styles.segmentActive]}
          >
            {option.icon ? <MaterialCommunityIcons name={option.icon} size={17} color={active ? colors.primary : colors.textMuted} /> : null}
            <Text style={[styles.segmentText, active && styles.segmentTextActive]}>{option.label}</Text>
          </ScalePressable>
        );
      })}
    </View>
  );
}

export function QuantityStepper({
  label,
  helper,
  value,
  onChange,
  min = 0,
  step = 1,
}: {
  label: string;
  helper?: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  step?: number;
}) {
  const update = (next: number) => {
    void Haptics.selectionAsync();
    onChange(Math.max(min, next));
  };

  return (
    <View style={styles.stepperRow}>
      <View style={{ flex: 1 }}>
        <Text style={styles.stepperLabel}>{label}</Text>
        {helper ? <Text style={styles.stepperHelper}>{helper}</Text> : null}
      </View>
      <View style={styles.stepperControl}>
        <ScalePressable onPress={() => update(value - step)} style={styles.stepperButton} haptic={false}>
          <MaterialCommunityIcons name="minus" size={19} color={colors.primary} />
        </ScalePressable>
        <TextInput
          keyboardType="number-pad"
          value={String(value)}
          onChangeText={(text) => onChange(Math.max(min, Number(text.replace(/\D/g, "")) || 0))}
          style={styles.stepperInput}
          selectionColor={colors.primary}
        />
        <ScalePressable onPress={() => update(value + step)} style={styles.stepperButton} haptic={false}>
          <MaterialCommunityIcons name="plus" size={19} color={colors.primary} />
        </ScalePressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fieldWrap: { gap: 7 },
  label: { color: colors.textMuted, fontSize: 12, fontWeight: "700" },
  input: { minHeight: 52, borderRadius: radius.md, backgroundColor: colors.backgroundRaised, borderWidth: 1, borderColor: colors.border, color: colors.text, paddingHorizontal: spacing.lg, fontSize: 15 },
  multiline: { minHeight: 100, paddingTop: 14, textAlignVertical: "top" },
  inputError: { borderColor: colors.danger },
  error: { color: colors.danger, fontSize: 11 },
  segmented: { flexDirection: "row", backgroundColor: colors.backgroundRaised, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: 4, gap: 4 },
  segment: { flex: 1, minHeight: 44, borderRadius: radius.sm, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 7 },
  segmentActive: { backgroundColor: colors.primaryMuted, borderWidth: 1, borderColor: colors.borderStrong },
  segmentText: { color: colors.textMuted, fontSize: 12, fontWeight: "700" },
  segmentTextActive: { color: colors.primary },
  stepperRow: { flexDirection: "row", alignItems: "center", gap: spacing.lg, paddingVertical: spacing.lg, borderBottomWidth: 1, borderBottomColor: colors.border },
  stepperLabel: { color: colors.text, fontSize: 15, fontWeight: "800" },
  stepperHelper: { color: colors.textDim, fontSize: 11, marginTop: 4 },
  stepperControl: { flexDirection: "row", alignItems: "center", borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, overflow: "hidden", backgroundColor: colors.background },
  stepperButton: { width: 42, height: 42, alignItems: "center", justifyContent: "center" },
  stepperInput: { width: 58, height: 42, borderLeftWidth: 1, borderRightWidth: 1, borderColor: colors.border, color: colors.text, textAlign: "center", fontWeight: "800" },
});
