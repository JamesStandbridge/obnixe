import { StyleSheet, View } from "react-native";
import type { ProgramEntry, VersionEntry } from "@obnixe/core";
import { MenuItem } from "@/ui/Inputs";
import { Text } from "@/ui/Text";
import { VersionRow } from "@/features/programs/VersionRows";

interface ProgramSheetProps {
  readonly entry: ProgramEntry;
  readonly activeEntry: ProgramEntry | null;
  readonly versions: readonly VersionEntry[];
  readonly onActivate: () => void;
  readonly onEdit: () => void;
  readonly onDuplicate: () => void;
  readonly onArchive: () => void;
  readonly onVersion: (version: VersionEntry) => void;
}

export function ProgramSheet({ entry, activeEntry, versions, onActivate, onEdit, onDuplicate, onArchive, onVersion }: ProgramSheetProps) {
  const status = entry.program.status;
  return (
    <View>
      <View style={styles.menu}>
        {status === "active" ? null : (
          <MenuItem label="Activer" detail={activeEntry === null ? "Devient le programme suivi" : `${activeEntry.version.name} sera archivé`} onPress={onActivate} />
        )}
        <MenuItem label="Modifier" detail={`Les modifications deviennent la v${entry.version.number + 1}`} onPress={onEdit} />
        <MenuItem label="Dupliquer" detail="Nouveau brouillon à partir de celui-ci" onPress={onDuplicate} />
        {status === "archived" ? null : <MenuItem label="Archiver" detail={status === "active" ? "Plus de prochaine séance proposée" : "Rangé avec les anciens programmes"} onPress={onArchive} />}
      </View>
      {versions.length === 0 ? null : (
        <View style={styles.versions}>
          <Text variant="sectionTitle" tone="secondary" accessibilityRole="header" style={styles.versionsTitle}>
            Versions
          </Text>
          {versions.map((version, index) => (
            <VersionRow key={version.version.id} entry={version} last={index === versions.length - 1} onPress={() => onVersion(version)} />
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  menu: { marginTop: 8 },
  versions: { marginTop: 20 },
  versionsTitle: { paddingBottom: 6 },
});
