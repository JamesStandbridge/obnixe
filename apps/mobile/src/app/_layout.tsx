import { useEffect } from "react";
import { SofiaSans_400Regular } from "@expo-google-fonts/sofia-sans/400Regular";
import { SofiaSans_500Medium } from "@expo-google-fonts/sofia-sans/500Medium";
import { SofiaSans_600SemiBold } from "@expo-google-fonts/sofia-sans/600SemiBold";
import { SofiaSans_700Bold } from "@expo-google-fonts/sofia-sans/700Bold";
import { SofiaSansCondensed_500Medium } from "@expo-google-fonts/sofia-sans-condensed/500Medium";
import { SofiaSansCondensed_600SemiBold } from "@expo-google-fonts/sofia-sans-condensed/600SemiBold";
import { SofiaSansCondensed_700Bold } from "@expo-google-fonts/sofia-sans-condensed/700Bold";
import { SofiaSansCondensed_800ExtraBold } from "@expo-google-fonts/sofia-sans-condensed/800ExtraBold";
import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import { hideAsync, preventAutoHideAsync } from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { DatabaseGate } from "@/data/DatabaseGate";
import { useAppLaunch } from "@/features/data/launch";
import { SnackbarHost } from "@/ui/SnackbarHost";
import { StartupError } from "@/ui/StartupError";
import { ThemeProvider, useTheme } from "@/ui/theme";

export { RouteError as ErrorBoundary } from "@/ui/RouteError";

void preventAutoHideAsync();

function Navigator() {
  const { name, colors } = useTheme();
  const { firstLaunch } = useAppLaunch();
  useEffect(() => {
    void hideAsync();
  }, []);
  return (
    <>
      <StatusBar style={name === "dark" ? "light" : "dark"} />
      <SnackbarHost>
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
          <Stack.Protected guard={!firstLaunch} redirectTo="/welcome">
            <Stack.Screen name="(tabs)" />
          </Stack.Protected>
          <Stack.Protected guard={firstLaunch} redirectTo="/">
            <Stack.Screen name="welcome" />
          </Stack.Protected>
        </Stack>
      </SnackbarHost>
    </>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    SofiaSans_400Regular,
    SofiaSans_500Medium,
    SofiaSans_600SemiBold,
    SofiaSans_700Bold,
    SofiaSansCondensed_500Medium,
    SofiaSansCondensed_600SemiBold,
    SofiaSansCondensed_700Bold,
    SofiaSansCondensed_800ExtraBold,
  });

  if (fontError !== null) return <StartupError title="Polices introuvables" detail={fontError.message} />;
  if (!fontsLoaded) return null;
  return (
    <DatabaseGate>
      <ThemeProvider>
        <Navigator />
      </ThemeProvider>
    </DatabaseGate>
  );
}
