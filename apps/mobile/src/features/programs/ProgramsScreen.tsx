import { useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { draftFromTree } from "@obnixe/core";
import type { ProgramEntry, VersionEntry, LatestZonePain } from "@obnixe/core";
import type { Id, ProgramStatus, ZoneKey } from "@obnixe/schema";
import { environment } from "@/data/database";
import { skipLabel, useProgramActions } from "@/features/programs/actions";
import type { ProgramActions } from "@/features/programs/actions";
import { useExerciseCatalog, useProgramsOverview, useRevision, useVersions, useZonePain } from "@/features/programs/data";
import type { ActiveProgram, ExerciseCatalog } from "@/features/programs/data";
import { authorLabel, formatLastDone, slotDetail, slotTitle } from "@/features/programs/format";
import { plural } from "@/format/labels";
import { ProgramSheet } from "@/features/programs/ProgramSheet";
import { RotationPanel } from "@/features/programs/RotationPanel";
import { VersionDiff, versionSheetContext, versionSheetTitle } from "@/features/programs/VersionDiff";
import { VersionRow } from "@/features/programs/VersionRows";
import { ControlButton, LinkButton, PrimaryButton } from "@/ui/Button";
import { Tag } from "@/ui/Controls";
import { Choices, IconButton, Panel } from "@/ui/Inputs";
import { AppBar, Screen, Section } from "@/ui/Layout";
import { Sheet } from "@/ui/Overlays";
import { Icon } from "@/ui/icons/Icon";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts } from "@/ui/tokens";

type ProgramsSheetState =
  | { readonly kind: "program"; readonly programId: Id }
  | { readonly kind: "version"; readonly programId: Id; readonly versionId: Id; readonly back: Id | null };

const visibleVersions = 4;

export const statusLabels: Readonly<Record<ProgramStatus, string>> = { active: "actif", draft: "brouillon", archived: "archivé" };

function otherDetail(entry: ProgramEntry): string {
  const status = statusLabels[entry.program.status];
  if (entry.program.status === "archived" && entry.firstSessionAt !== null && entry.lastSessionAt !== null) {
    const weeks = Math.max(1, Math.round((entry.lastSessionAt - entry.firstSessionAt) / (7 * 86_400_000)));
    return `${status} · ${plural(weeks, "semaine")} · ${plural(entry.completedSessions, "séance")}`;
  }
  return `${status} · ${plural(entry.slotCount, "séance")}`;
}

export function ProgramsScreen() {
  const revision = useRevision();
  const overview = useProgramsOverview(revision);
  const catalog = useExerciseCatalog();
  const pain = useZonePain(revision);
  const actions = useProgramActions(catalog.name);
  const [sheet, setSheet] = useState<ProgramsSheetState | null>(null);
  const [open, setOpen] = useState(false);
  const [allVersions, setAllVersions] = useState(false);

  const show = (next: ProgramsSheetState): void => {
    setSheet(next);
    setOpen(true);
  };
  const close = (): void => setOpen(false);

  const sheetProgramId = sheet?.programId ?? null;
  const sheetVersions = useVersions(revision, sheetProgramId);
  const entries = useMemo(() => [...(overview.active === null ? [] : [overview.active.entry]), ...overview.others], [overview]);
  const sheetEntry = entries.find((entry) => entry.program.id === sheetProgramId) ?? null;

  const active = overview.active;
  const shownVersions = active === null ? [] : allVersions ? active.versions : active.versions.slice(0, visibleVersions);

  return (
    <>
      <Screen>
        <AppBar title="Programmes" trailing={<LinkButton label="Nouveau" onPress={() => router.push("/program/new")} style={styles.appbarLink} />} />
        {active === null ? (
          <EmptyActive hasOthers={overview.others.length > 0} />
        ) : (
          <ActiveSection active={active} onMore={() => show({ kind: "program", programId: active.entry.program.id })} onSkip={actions.skip} />
        )}
        {active === null || active.versions.length === 0 ? null : (
          <Section title="Versions">
            {shownVersions.map((entry, index) => (
              <VersionRow
                key={entry.version.id}
                entry={entry}
                last={index === shownVersions.length - 1}
                onPress={() => show({ kind: "version", programId: active.entry.program.id, versionId: entry.version.id, back: null })}
              />
            ))}
            {active.versions.length > visibleVersions ? (
              <LinkButton
                label={allVersions ? "Moins de versions" : `Toutes les versions (${active.versions.length})`}
                onPress={() => setAllVersions((value) => !value)}
                style={styles.moreVersions}
              />
            ) : null}
          </Section>
        )}
        {overview.others.length === 0 ? null : (
          <Section title="Autres programmes">
            {overview.others.map((entry, index) => (
              <OtherRow key={entry.program.id} entry={entry} last={index === overview.others.length - 1} onPress={() => show({ kind: "program", programId: entry.program.id })} />
            ))}
          </Section>
        )}
      </Screen>
      <ProgramsSheet
        open={open}
        sheet={sheet}
        entry={sheetEntry}
        activeEntry={active?.entry ?? null}
        versions={sheetVersions}
        catalog={catalog}
        pain={pain}
        actions={actions}
        onShow={show}
        onClose={close}
      />
    </>
  );
}

interface ProgramsSheetProps {
  readonly open: boolean;
  readonly sheet: ProgramsSheetState | null;
  readonly entry: ProgramEntry | null;
  readonly activeEntry: ProgramEntry | null;
  readonly versions: readonly VersionEntry[];
  readonly catalog: ExerciseCatalog;
  readonly pain: ReadonlyMap<ZoneKey, LatestZonePain>;
  readonly actions: ProgramActions;
  readonly onShow: (sheet: ProgramsSheetState) => void;
  readonly onClose: () => void;
}

function ProgramsSheet({ open, sheet, entry, activeEntry, versions, catalog, pain, actions, onShow, onClose }: ProgramsSheetProps) {
  if (sheet === null || entry === null) return <Sheet open={false} title="" onClose={onClose}>{null}</Sheet>;
  switch (sheet.kind) {
    case "program":
      return (
        <Sheet open={open} title={entry.version.name} context={`${statusLabels[entry.program.status]} · v${entry.version.number} · ${plural(entry.slotCount, "séance")}`} onClose={onClose}>
          <ProgramSheet
            entry={entry}
            activeEntry={activeEntry}
            versions={entry.program.status === "active" ? [] : versions}
            onActivate={() => {
              onClose();
              actions.activate(entry);
            }}
            onEdit={() => {
              onClose();
              router.push(`/program/${entry.program.id}`);
            }}
            onDuplicate={() => {
              onClose();
              actions.duplicate(entry);
            }}
            onArchive={() => {
              onClose();
              actions.archive(entry);
            }}
            onVersion={(version) => onShow({ kind: "version", programId: entry.program.id, versionId: version.version.id, back: entry.program.id })}
          />
        </Sheet>
      );
    case "version": {
      const index = versions.findIndex((version) => version.version.id === sheet.versionId);
      const version = versions[index];
      if (version === undefined) return <Sheet open={false} title="" onClose={onClose}>{null}</Sheet>;
      const previous = versions[index + 1] ?? null;
      const back = sheet.back;
      const dismiss = back === null ? onClose : () => onShow({ kind: "program", programId: back });
      return (
        <Sheet open={open} title={versionSheetTitle(version)} context={versionSheetContext(version)} onClose={onClose}>
          <VersionDiff entry={version} previous={previous} name={catalog.name} zones={catalog.zones} pain={pain} />
          <Choices
            items={version.revertible ? [{ value: "revert", label: "Annuler ce changement" }, { value: "keep", label: "Garder" }] : [{ value: "keep", label: back === null ? "Fermer" : "Retour" }]}
            onChoose={(choice) => {
              if (choice === "revert") {
                onClose();
                actions.revertVersion(version);
                return;
              }
              dismiss();
            }}
          />
        </Sheet>
      );
    }
    default: {
      const unreachable: never = sheet;
      return unreachable;
    }
  }
}

interface ActiveSectionProps {
  readonly active: ActiveProgram;
  readonly onMore: () => void;
  readonly onSkip: () => void;
}

function ActiveSection({ active, onMore, onSkip }: ActiveSectionProps) {
  const draft = useMemo(() => draftFromTree(active.tree), [active.tree]);
  const now = environment.now();
  const next = active.next;
  const { entry } = active;
  return (
    <View style={styles.active}>
      <View style={styles.activeHead}>
        <Text variant="eyebrow" tone="secondary">
          Actif
        </Text>
        <IconButton icon="more" label={`Options de ${entry.version.name}`} edge="end" onPress={onMore} />
      </View>
      <Text accessibilityRole="header" style={styles.activeName}>
        {entry.version.name}
      </Text>
      <Text tone="secondary">
        v{entry.version.number} · rotation de {plural(draft.slots.length, "séance")} · {entry.version.sessionsPerWeek} par semaine
      </Text>
      <RotationPanel
        rows={draft.slots.map((slot) => {
          const isNext = next?.slot.lineageId === slot.lineageId;
          const last = active.lastDone.get(slot.lineageId);
          return {
            key: slot.lineageId,
            sport: slot.sport,
            title: slotTitle(slot),
            detail: slotDetail(slot),
            next: isNext,
            value: isNext ? "Prochaine" : last === undefined ? null : formatLastDone(last, now),
          };
        })}
      />
      <View style={styles.actions}>
        <ControlButton label="Modifier" onPress={() => router.push(`/program/${entry.program.id}`)} style={styles.action} />
        {next === null || draft.slots.length < 2 ? null : <ControlButton label={skipLabel(next.slot)} onPress={onSkip} style={styles.action} />}
      </View>
    </View>
  );
}

interface EmptyActiveProps {
  readonly hasOthers: boolean;
}

function EmptyActive({ hasOthers }: EmptyActiveProps) {
  return (
    <View style={styles.active}>
      <Text variant="eyebrow" tone="secondary">
        Aucun programme actif
      </Text>
      <Panel style={styles.empty}>
        <Text variant="bodyStrong">{hasOthers ? "Active un programme pour suivre sa rotation." : "Une rotation de séances, dans l'ordre."}</Text>
        <Text tone="secondary" variant="small">
          {hasOthers ? "Ou crée-en un nouveau." : "Musculation, course, escalade : chaque séance suit la précédente, sans calendrier figé."}
        </Text>
      </Panel>
      <PrimaryButton label="Créer un programme" onPress={() => router.push("/program/new")} style={styles.emptyAction} />
    </View>
  );
}

interface OtherRowProps {
  readonly entry: ProgramEntry;
  readonly last: boolean;
  readonly onPress: () => void;
}

function OtherRow({ entry, last, onPress }: OtherRowProps) {
  const { colors } = useTheme();
  const detail = otherDetail(entry);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${entry.version.name}, ${detail}`}
      onPress={onPress}
      style={({ pressed }) => [styles.otherRow, { borderBottomColor: colors.line, borderBottomWidth: last ? 0 : 1 }, pressed && { backgroundColor: colors.surface }]}
    >
      <View style={styles.otherMain}>
        <Text variant="bodyStrong" numberOfLines={1}>
          {entry.version.name}
        </Text>
        <View style={styles.otherMeta}>
          {entry.author.author === "agent" ? <Tag label={authorLabel(entry.author)} /> : null}
          <Text variant="small" tone="secondary">
            {detail}
          </Text>
        </View>
      </View>
      <Icon name="chevron" color={colors.text3} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  appbarLink: { marginRight: -10 },
  active: { marginTop: 18, gap: 6 },
  activeHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 24, marginBottom: -10, marginTop: -10 },
  activeName: { fontFamily: fonts.text700, fontSize: 30, lineHeight: 32, letterSpacing: -0.6 },
  actions: { marginTop: 4, flexDirection: "row", gap: 6 },
  action: { flex: 1 },
  moreVersions: { alignSelf: "flex-start", marginLeft: -10, marginTop: 4 },
  empty: { marginTop: 8, gap: 6 },
  emptyAction: { marginTop: 10 },
  otherRow: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 56, paddingVertical: 10 },
  otherMain: { flex: 1, minWidth: 0, gap: 3 },
  otherMeta: { flexDirection: "row", alignItems: "center", gap: 6 },
});
