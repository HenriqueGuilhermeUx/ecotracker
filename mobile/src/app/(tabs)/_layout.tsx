import { MaterialCommunityIcons } from "@expo/vector-icons";
import { Tabs } from "expo-router";
import { colors } from "../../theme";

const icon = (name: keyof typeof MaterialCommunityIcons.glyphMap) =>
  ({ color, size }: { color: string; size: number }) => <MaterialCommunityIcons name={name} color={color} size={size} />;

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textDim,
        tabBarStyle: {
          position: "absolute",
          left: 14,
          right: 14,
          bottom: 14,
          height: 72,
          paddingTop: 8,
          paddingBottom: 8,
          borderRadius: 22,
          backgroundColor: "#0B1A13F5",
          borderTopWidth: 0,
          borderWidth: 1,
          borderColor: colors.borderStrong,
          elevation: 18,
        },
        tabBarLabelStyle: { fontSize: 10, fontWeight: "700" },
        sceneStyle: { backgroundColor: colors.background },
      }}
    >
      <Tabs.Screen name="index" options={{ title: "Início", tabBarIcon: icon("home-variant-outline") }} />
      <Tabs.Screen name="market" options={{ title: "Mercado", tabBarIcon: icon("leaf-circle-outline") }} />
      <Tabs.Screen name="impact" options={{ title: "Calcular", tabBarIcon: icon("calculator-variant-outline") }} />
      <Tabs.Screen name="activity" options={{ title: "Atividade", tabBarIcon: icon("timeline-clock-outline") }} />
      <Tabs.Screen name="profile" options={{ title: "Conta", tabBarIcon: icon("account-circle-outline") }} />
    </Tabs>
  );
}
