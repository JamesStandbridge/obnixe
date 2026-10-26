import { Pressable, StyleSheet, View } from "react-native";
import type { VersionEntry } from "@obnixe/core";
import { authorLabel, formatRelative } from "@/features/programs/format";
import { environment } from "@/data/database";
import { Tag } from "@/ui/Controls";
import { Icon } from "@/ui/icons/Icon";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts } from "@/ui/tokens";

export function versionTitle(entry: VersionEntry): string {
  return entry.version.summary ?? (entry.version.number === 1 ? "Création du programme" : `Version ${entry.version.number}`);
}

interface AuthorMarkProps {
  readonly entry: VersionEntry;
}

export function AuthorMark({ entry }: AuthorMarkProps) {
  const label = authorLabel(entry.author);
  if (entry.author.author === "agent") return <Tag label={label} />;
  return (
    <Text variant="caption" tone="secondary" style={styles.plainTag}>
      {label}
    </Text>
  );
}

interface VersionRowProps {
  readonly entry: VersionEntry;
  readonly last: boolean;
  readonly onPress: () => void;
}

export function VersionRow({ entry, last, onPress }: VersionRowProps) {
  const { colors } = useTheme();
  const when = formatRelative(entry.version.createdAt, environment.now());
  const title = versionTitle(entry);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Version ${entry.version.number}, ${title}, ${authorLabel(entry.author)}, ${when}`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, { borderBottomColor: colors.line, borderBottomWidth: last ? 0 : 1 }, pressed && { backgroundColor: colors.surface }]}
    >
      <Text style={[styles.number, { color: entry.latest ? colors.text : colors.text2 }]}>v{entry.version.number}</Text>
      <View style={styles.main}>
        <Text variant="bodyStrong" style={styles.title}>
          {title}
        </Text>
        <View style={styles.meta}>
          <AuthorMark entry={entry} />
          <Text variant="small" tone="secondary">
            {when}
          </Text>
        </View>
      </View>
      <Icon name="chevron" color={colors.text3} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "flex-start", gap: 12, minHeight: 56, paddingVertical: 10 },
  number: { width: 40, fontFamily: fonts.figure700, fontSize: 17, lineHeight: 22 },
  main: { flex: 1, minWidth: 0, gap: 3 },
  title: { lineHeight: 21 },
  meta: { flexDirection: "row", alignItems: "center", gap: 6 },
  plainTag: { fontFamily: fonts.text700, fontSize: 12, lineHeight: 20, letterSpacing: 0.24 },
});
