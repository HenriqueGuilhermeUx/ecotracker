import "react-native-gesture-handler";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { AppProvider } from "../context/AppContext";
import { colors } from "../theme";

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.background }}>
      <AppProvider>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: colors.background },
            headerTintColor: colors.text,
            headerShadowVisible: false,
            contentStyle: { backgroundColor: colors.background },
            animation: "slide_from_right",
          }}
        >
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="asset/[id]" options={{ title: "Ativo ambiental", headerBackTitle: "Voltar" }} />
          <Stack.Screen name="quote/new" options={{ title: "Solicitar cotação", presentation: "modal" }} />
          <Stack.Screen name="quote/[code]" options={{ title: "Minha operação", headerBackTitle: "Voltar" }} />
        </Stack>
      </AppProvider>
    </GestureHandlerRootView>
  );
}
