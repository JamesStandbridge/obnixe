import { StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { LinkButton, PrimaryButton } from "@/ui/Button";
import { IconButton } from "@/ui/Inputs";
import { AppBar, Screen } from "@/ui/Layout";
import { Text } from "@/ui/Text";

export function goBack(): void {
  if (router.canGoBack()) router.back();
  else router.replace("/");
}

export interface MessageAction {
  readonly label: string;
  readonly run: () => void;
}

interface MessageProps {
  readonly title: string;
  readonly detail: string;
  readonly action: MessageAction | null;
}

export function Message({ title, detail, action }: MessageProps) {
  return (
    <Screen>
      <AppBar title="" leading={<IconButton icon="back" label="Retour" edge="start" onPress={goBack} />} />
      <View style={styles.message}>
        <Text variant="title" accessibilityRole="header">
          {title}
        </Text>
        <Text tone="secondary">{detail}</Text>
        {action === null ? <LinkButton label="Retour" onPress={goBack} style={styles.back} /> : <PrimaryButton label={action.label} onPress={action.run} style={styles.action} />}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  message: { marginTop: 24, gap: 10 },
  action: { marginTop: 16 },
  back: { alignSelf: "flex-start", marginLeft: -10, marginTop: 8 },
});
