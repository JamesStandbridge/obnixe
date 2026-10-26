import { useMemo, useReducer, useRef, useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import { router, usePreventRemove } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { eq } from "drizzle-orm";
import {
  changedItemLineages,
  copyVariantItems,
  diffDrafts,
  draftFromTree,
  emptyDraft,
  exerciseRefs,
  exerciseUsage,
  latestVersion,
  listVersions,
  loadVersionTree,
  nextSlot,
  planCreateProgram,
  planPublish,
  planRestoreExercise,
  programLimits,
  validateDraft,
} from "@obnixe/core";
import type { DraftItem, DraftSlot, ProgramDraft, PublishedBase, LatestZonePain } from "@obnixe/core";
import { exercise as exerciseTable, program, sports } from "@obnixe/schema";
import type { Exercise, Id, MassUnit, ProgramStatus, SportKey, ZoneKey } from "@obnixe/schema";
import { db, environment } from "@/data/database";
import { useUndoableWrite, write } from "@/data/write";
import { useEnabledSports, useExerciseCatalog, useMassUnit, useRevision, useZonePain } from "@/features/programs/data";
import type { ExerciseCatalog } from "@/features/programs/data";
import { authorLabel, changeCountLabel, issueMessage, plural, summarizeChanges } from "@/features/programs/format";
import { ExerciseForm } from "@/features/programs/exercises/ExerciseForm";
import { ExercisePicker } from "@/features/programs/exercises/ExercisePicker";
import { draftReducer } from "@/features/programs/editor/draftReducer";
import type { DraftAction } from "@/features/programs/editor/draftReducer";
import { ItemSheet, newItem, withExercise } from "@/features/programs/editor/ItemSheet";
import { SlotList } from "@/features/programs/editor/SlotList";
import type { ItemMarks } from "@/features/programs/editor/SlotList";
import { AddSlotSheet, NewVariantSheet, PadSheet, SlotSheet, padFieldLabel } from "@/features/programs/editor/SlotSheets";
import { ControlButton, LinkButton, PrimaryButton } from "@/ui/Button";
import { Stepper } from "@/ui/Controls";
import { Choices, IconButton } from "@/ui/Inputs";
import { Screen, Section } from "@/ui/Layout";
import { Sheet } from "@/ui/Overlays";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts, layout, radii } from "@/ui/tokens";

interface ItemPurpose {
  readonly slotId: Id;
  readonly variantId: Id;
  readonly item: DraftItem | null;
  readonly isNew: boolean;
}

type EditorSheet =
  | { readonly kind: "add_slot" }
  | { readonly kind: "slot"; readonly slotId: Id }
  | { readonly kind: "new_variant"; readonly slotId: Id; readonly sourceId: Id | null }
  | { readonly kind: "pad"; readonly slotId: Id; readonly field: string }
  | { readonly kind: "picker"; readonly purpose: ItemPurpose; readonly query: string }
  | { readonly kind: "exercise"; readonly exerciseId: Id | null; readonly name: string; readonly purpose: ItemPurpose; readonly query: string }
  | { readonly kind: "item"; readonly slotId: Id; readonly variantId: Id; readonly item: DraftItem; readonly isNew: boolean }
  | { readonly kind: "discard" };

interface EditorBase {
  readonly programId: Id;
  readonly status: ProgramStatus;
  readonly published: PublishedBase;
  readonly agentItems: ReadonlySet<Id>;
  readonly agentLabel: string | null;
  readonly nextSlot: Id | null;
}

type Loaded = { readonly kind: "new" } | { readonly kind: "existing"; readonly base: EditorBase } | { readonly kind: "missing" };

function loadBase(id: string): Loaded {
  if (id === "new") return { kind: "new" };
  const database = db();
  const row = database.select().from(program).where(eq(program.id, id as Id)).get();
  const version = row === undefined ? null : latestVersion(database, row.id);
  const tree = version === null ? null : loadVersionTree(database, version.id);
  if (row === undefined || version === null || tree === null) return { kind: "missing" };
  const draft = draftFromTree(tree);
  const versions = listVersions(database, row.id);
  const latest = versions[0];
  const previous = versions[1];
  let agentItems: ReadonlySet<Id> = new Set();
  if (latest !== undefined && latest.author.author === "agent" && previous !== undefined) {
    const previousTree = loadVersionTree(database, previous.version.id);
    if (previousTree !== null) agentItems = changedItemLineages(diffDrafts(draftFromTree(previousTree), draft));
  }
  return {
    kind: "existing",
    base: {
      programId: row.id,
      status: row.status,
      published: { version, draft },
      agentItems,
      agentLabel: latest !== undefined && latest.author.author === "agent" ? authorLabel(latest.author) : null,
      nextSlot: row.status === "active" ? (nextSlot(database)?.slot.lineageId ?? null) : null,
    },
  };
}

function nextStrengthName(draft: ProgramDraft): string {
  const used = new Set(draft.slots.map((slot) => slot.name.trim()));
  for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") if (!used.has(`Séance ${letter}`)) return `Séance ${letter}`;
  return `Séance ${draft.slots.length + 1}`;
}

function readExercise(id: Id): Exercise | null {
  return db().select().from(exerciseTable).where(eq(exerciseTable.id, id)).get() ?? null;
}

interface ProgramEditorProps {
  readonly id: string;
}

export function ProgramEditor({ id }: ProgramEditorProps) {
  const [generation, setGeneration] = useState(0);
  const loaded = useMemo(() => loadBase(id), [id, generation]);
  switch (loaded.kind) {
    case "missing":
      return <MissingProgram />;
    case "new":
      return <Editor key={generation} base={null} onReload={() => setGeneration((value) => value + 1)} />;
    case "existing":
      return <Editor key={generation} base={loaded.base} onReload={() => setGeneration((value) => value + 1)} />;
    default: {
      const unreachable: never = loaded;
      return unreachable;
    }
  }
}

function MissingProgram() {
  return (
    <Screen>
      <View style={styles.appbar}>
        <IconButton icon="close" label="Fermer" edge="start" onPress={() => (router.canGoBack() ? router.back() : router.replace("/programs"))} />
        <Text variant="label" tone="secondary" style={styles.context}>
          Programme introuvable
        </Text>
      </View>
      <Text tone="secondary" style={styles.missing}>
        Ce programme n'existe plus sur ce téléphone.
      </Text>
    </Screen>
  );
}

interface EditorProps {
  readonly base: EditorBase | null;
  readonly onReload: () => void;
}

function Editor({ base, onReload }: EditorProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const revision = useRevision();
  const catalog = useExerciseCatalog();
  const pain = useZonePain(revision);
  const enabled = useEnabledSports(revision);
  const massUnit = useMassUnit();
  const undoable = useUndoableWrite();
  const [draft, dispatch] = useReducer(draftReducer, base?.published.draft ?? emptyDraft());
  const [openSlot, setOpenSlot] = useState<Id | null>(base?.nextSlot ?? null);
  const [selectedVariants, setSelectedVariants] = useState<ReadonlyMap<Id, Id>>(new Map());
  const [sheet, setSheet] = useState<EditorSheet | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [stale, setStale] = useState<number | null>(null);
  const pendingLeave = useRef<(() => void) | null>(null);

  const refs = useMemo(() => exerciseRefs(catalog.exercises), [catalog.exercises]);
  const changes = useMemo(() => (base === null ? [] : diffDrafts(base.published.draft, draft)), [base, draft]);
  const validation = useMemo(() => validateDraft(draft, refs), [draft, refs]);
  const dirty = base === null ? draft.name.trim() !== "" || draft.slots.length > 0 || draft.sessionsPerWeek !== emptyDraft().sessionsPerWeek : changes.length > 0;
  const canSave = dirty && validation.valid && stale === null;
  const nextNumber = base === null ? 1 : base.published.version.number + 1;

  const disablePrevention = usePreventRemove(dirty, ({ repeat }) => {
    pendingLeave.current = repeat;
    show({ kind: "discard" });
  });

  const show = (next: EditorSheet): void => {
    setSheet(next);
    setSheetOpen(true);
  };
  const close = (): void => setSheetOpen(false);

  const leave = (): void => {
    disablePrevention();
    if (router.canGoBack()) router.back();
    else router.replace("/programs");
  };

  const requestClose = (): void => {
    if (!dirty) {
      leave();
      return;
    }
    pendingLeave.current = null;
    show({ kind: "discard" });
  };

  const discard = (): void => {
    close();
    disablePrevention();
    const repeat = pendingLeave.current;
    pendingLeave.current = null;
    if (repeat !== null) repeat();
    else leave();
  };

  const publish = (): void => {
    if (!canSave) return;
    const name = draft.name.trim();
    if (base === null) {
      const hasActive = db().select({ id: program.id }).from(program).where(eq(program.status, "active")).get() !== undefined;
      const result = planCreateProgram({ draft, status: hasActive ? "draft" : "active", copiedFromId: null, summary: null, reason: null, exercises: refs }, environment.newId);
      if (!result.ok) return;
      undoable({ summary: `Création : ${name}`, mutations: result.plan.mutations, message: hasActive ? `${name} créé en brouillon` : `${name} créé et actif` });
      leave();
      return;
    }
    const latest = latestVersion(db(), base.programId);
    if (latest?.id !== base.published.version.id) {
      setStale(latest?.number ?? base.published.version.number);
      return;
    }
    const result = planPublish(
      { programId: base.programId, base: base.published, draft, summary: summarizeChanges(changes, catalog.name), reason: null, exercises: refs },
      environment.newId,
    );
    if (!result.ok) return;
    undoable({ summary: `${name} · v${result.plan.number}`, mutations: result.plan.mutations, message: `Enregistré comme v${result.plan.number}` });
    leave();
  };

  const addSlot = (sport: SportKey): void => {
    const lineageId = environment.newId();
    const strength = sports[sport].archetype === "strength";
    const slot: DraftSlot = {
      lineageId,
      sport,
      name: strength ? nextStrengthName(draft) : sports[sport].label,
      targetDurationSeconds: null,
      targetEffort: null,
      targetValues: {},
      variants: strength ? [{ lineageId: environment.newId(), name: "Salle", items: [] }] : [],
    };
    dispatch({ type: "add_slot", slot });
    setOpenSlot(lineageId);
    close();
  };

  const pickExercise = (purpose: ItemPurpose, picked: Exercise): void => {
    const item = purpose.item === null ? newItem(picked, environment.newId()) : withExercise(purpose.item, picked);
    show({ kind: "item", slotId: purpose.slotId, variantId: purpose.variantId, item, isNew: purpose.isNew });
  };

  const marks: ItemMarks = { name: catalog.name, zones: catalog.zones, pain, agentItems: base?.agentItems ?? new Set(), agentLabel: base?.agentLabel ?? null };
  const firstIssue = validation.valid ? null : issueMessage(validation.issues[0], draft, catalog.name);
  const changeLabel = base === null ? (dirty ? "Nouveau programme" : "Aucune modification") : changeCountLabel(changes.length);
  const contextLabel = base === null ? "Nouveau programme" : `Modifier le programme · v${base.published.version.number}`;

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <Screen bottomInset={120}>
        <View style={styles.appbar}>
          <IconButton icon="close" label="Fermer sans enregistrer" edge="start" onPress={requestClose} />
          <Text variant="label" tone="secondary" style={styles.context} accessibilityRole="header">
            {contextLabel}
          </Text>
        </View>
        <TextInput
          value={draft.name}
          onChangeText={(name) => dispatch({ type: "rename", name })}
          placeholder="Nom du programme"
          accessibilityLabel="Nom du programme"
          placeholderTextColor={colors.text3}
          selectionColor={colors.mark}
          autoFocus={base === null}
          style={[styles.name, { backgroundColor: colors.surface, borderColor: colors.controlBorder, color: colors.text }]}
        />
        <View style={styles.frequency}>
          <Text variant="bodyStrong" style={styles.frequencyLabel}>
            Séances par semaine
          </Text>
          <View style={styles.frequencyStepper}>
            <Stepper
              label="Séances par semaine"
              value={draft.sessionsPerWeek}
              step={1}
              min={programLimits.sessionsPerWeek.min}
              max={programLimits.sessionsPerWeek.max}
              unit=""
              format={String}
              onChange={(value) => dispatch({ type: "frequency", value })}
            />
          </View>
        </View>
        <Section title="Rotation">
          {draft.slots.length === 0 ? (
            <Text tone="secondary" variant="small" style={styles.emptyRotation}>
              Les séances s'enchaînent dans cet ordre, puis la rotation recommence.
            </Text>
          ) : null}
          <SlotList
            slots={draft.slots}
            openSlot={openSlot}
            nextSlot={base?.nextSlot ?? null}
            selectedVariants={selectedVariants}
            marks={marks}
            onToggle={(slotId) => setOpenSlot((current) => (current === slotId ? null : slotId))}
            onSelectVariant={(slotId, variantId) => setSelectedVariants((current) => new Map(current).set(slotId, variantId))}
            onAddVariant={(slotId) => show({ kind: "new_variant", slotId, sourceId: selectedVariants.get(slotId) ?? draft.slots.find((slot) => slot.lineageId === slotId)?.variants[0]?.lineageId ?? null })}
            onEditSlot={(slotId) => show({ kind: "slot", slotId })}
            onPatchSlot={(slotId, patch) => dispatch({ type: "update_slot", slotId, patch })}
            onPad={(slotId, field) => show({ kind: "pad", slotId, field })}
            onItem={(slot, variant, item) => show({ kind: "item", slotId: slot.lineageId, variantId: variant.lineageId, item, isNew: false })}
            onAddItem={(slot, variant) => show({ kind: "picker", purpose: { slotId: slot.lineageId, variantId: variant.lineageId, item: null, isNew: true }, query: "" })}
          />
          <ControlButton label="Ajouter à la rotation" onPress={() => show({ kind: "add_slot" })} style={styles.add} />
        </Section>
        <View style={styles.changes}>
          <Text variant="small" style={styles.changeCount}>
            {changeLabel}
          </Text>
          {(dirty || base !== null) && firstIssue !== null ? (
            <Text variant="small" tone="secondary">
              {firstIssue}
            </Text>
          ) : null}
          {stale === null ? null : (
            <View style={styles.stale}>
              <Text variant="small" tone="secondary">
                La v{stale} a été enregistrée pendant ta modification.
              </Text>
              <LinkButton
                label={`Repartir de la v${stale}`}
                onPress={() => {
                  disablePrevention();
                  onReload();
                }}
                style={styles.staleLink}
              />
            </View>
          )}
        </View>
      </Screen>
      <View style={[styles.bottom, { backgroundColor: colors.bg, borderTopColor: colors.line, paddingBottom: insets.bottom + 12 }]}>
        <PrimaryButton label={base === null ? "Créer le programme" : `Enregistrer comme v${nextNumber}`} disabled={!canSave} onPress={publish} />
      </View>
      <EditorSheets
        sheet={sheet}
        open={sheetOpen}
        draft={draft}
        dispatch={dispatch}
        catalog={catalog}
        pain={pain}
        enabled={enabled}
        massUnit={massUnit}
        changesCount={changes.length}
        isNew={base === null}
        show={show}
        close={close}
        onAddSlot={addSlot}
        onPick={pickExercise}
        onDiscard={discard}
        onRemoveSlot={(slotId) => {
          dispatch({ type: "remove_slot", slotId });
          if (openSlot === slotId) setOpenSlot(null);
          close();
        }}
        onCreatedVariant={(slotId, variantId) => setSelectedVariants((current) => new Map(current).set(slotId, variantId))}
      />
    </View>
  );
}

interface EditorSheetsProps {
  readonly sheet: EditorSheet | null;
  readonly open: boolean;
  readonly draft: ProgramDraft;
  readonly dispatch: (action: DraftAction) => void;
  readonly catalog: ExerciseCatalog;
  readonly pain: ReadonlyMap<ZoneKey, LatestZonePain>;
  readonly enabled: readonly SportKey[];
  readonly massUnit: MassUnit;
  readonly changesCount: number;
  readonly isNew: boolean;
  readonly show: (sheet: EditorSheet) => void;
  readonly close: () => void;
  readonly onAddSlot: (sport: SportKey) => void;
  readonly onPick: (purpose: ItemPurpose, exercise: Exercise) => void;
  readonly onDiscard: () => void;
  readonly onRemoveSlot: (slotId: Id) => void;
  readonly onCreatedVariant: (slotId: Id, variantId: Id) => void;
}

function EditorSheets(props: EditorSheetsProps) {
  const { sheet, open, draft, dispatch, catalog, pain, show, close } = props;
  const findSlot = (slotId: Id): DraftSlot | null => draft.slots.find((slot) => slot.lineageId === slotId) ?? null;
  const placeOf = (slotId: Id, variantId: Id): string => {
    const slot = findSlot(slotId);
    const variant = slot?.variants.find((entry) => entry.lineageId === variantId);
    return slot === null || variant === undefined ? "" : slot.variants.length > 1 ? `${slot.name} · ${variant.name}` : slot.name;
  };
  if (sheet === null) return null;
  switch (sheet.kind) {
    case "add_slot":
      return (
        <Sheet open={open} title="Ajouter à la rotation" onClose={close}>
          <AddSlotSheet sports={props.enabled} onAdd={props.onAddSlot} />
        </Sheet>
      );
    case "slot": {
      const slot = findSlot(sheet.slotId);
      if (slot === null) return null;
      const position = draft.slots.indexOf(slot);
      return (
        <Sheet open={open} title={slot.name.trim() === "" ? "Séance" : slot.name} context={`${sports[slot.sport].label} · ${position + 1} sur ${draft.slots.length}`} onClose={close}>
          <SlotSheet slot={slot} position={position} count={draft.slots.length} dispatch={dispatch} onRemove={() => props.onRemoveSlot(slot.lineageId)} onDone={close} />
        </Sheet>
      );
    }
    case "new_variant": {
      const slot = findSlot(sheet.slotId);
      if (slot === null) return null;
      const source = slot.variants.find((variant) => variant.lineageId === sheet.sourceId) ?? null;
      return (
        <Sheet open={open} title="Nouvelle variante" context={slot.name} onClose={close}>
          <NewVariantSheet
            slot={slot}
            source={source}
            onCreate={(name, copy) => {
              const variantId = environment.newId();
              const items = copy && source !== null ? copyVariantItems(source, environment.newId) : [];
              dispatch({ type: "add_variant", slotId: slot.lineageId, variant: { lineageId: variantId, name, items } });
              props.onCreatedVariant(slot.lineageId, variantId);
              close();
            }}
          />
        </Sheet>
      );
    }
    case "pad": {
      const slot = findSlot(sheet.slotId);
      if (slot === null) return null;
      return (
        <Sheet open={open} title={padFieldLabel(slot, sheet.field)} context={`${slot.name} · objectif`} onClose={close}>
          <PadSheet
            key={`${slot.lineageId}-${sheet.field}`}
            slot={slot}
            fieldKey={sheet.field}
            onValue={(value) => {
              const targetValues = { ...slot.targetValues };
              if (value === null) delete targetValues[sheet.field];
              else targetValues[sheet.field] = value;
              dispatch({ type: "update_slot", slotId: slot.lineageId, patch: { targetValues } });
              close();
            }}
          />
        </Sheet>
      );
    }
    case "picker": {
      const { purpose } = sheet;
      return (
        <Sheet open={open} title={purpose.item === null ? "Ajouter un exercice" : "Changer d'exercice"} context={placeOf(purpose.slotId, purpose.variantId)} onClose={close}>
          <ExercisePicker
            key={`${purpose.item?.lineageId ?? "new"}-${sheet.query}`}
            exercises={catalog.exercises}
            zones={catalog.zones}
            pain={pain}
            initialQuery={sheet.query}
            currentId={purpose.item?.exerciseId ?? null}
            onPick={(picked) => props.onPick(purpose, picked)}
            onCreate={(name) => show({ kind: "exercise", exerciseId: null, name, purpose, query: name })}
            onEdit={(picked, query) => show({ kind: "exercise", exerciseId: picked.id, name: picked.name, purpose, query })}
            onRestore={(picked) => {
              const mutation = planRestoreExercise(picked);
              if (mutation !== null) write(`Exercice restauré : ${picked.name}`, [mutation]);
            }}
          />
        </Sheet>
      );
    }
    case "exercise": {
      const current = sheet.exerciseId === null ? null : readExercise(sheet.exerciseId);
      const backToPicker = (): void => show({ kind: "picker", purpose: sheet.purpose, query: sheet.query });
      return (
        <Sheet open={open} title={current === null ? "Nouvel exercice" : "Modifier l'exercice"} {...(current === null ? {} : { context: current.name })} onClose={backToPicker}>
          <ExerciseForm
            key={sheet.exerciseId ?? `new-${sheet.name}`}
            exercise={current}
            exerciseZones={current === null ? [] : (catalog.zones.get(current.id) ?? [])}
            usage={current === null ? { inUse: false, programNames: [] } : exerciseUsage(db(), current.id)}
            initialName={sheet.name}
            exercises={catalog.exercises}
            massUnit={props.massUnit}
            onDone={(exerciseId) => {
              const saved = readExercise(exerciseId);
              if (current === null && saved !== null) props.onPick(sheet.purpose, saved);
              else backToPicker();
            }}
            onArchived={backToPicker}
          />
        </Sheet>
      );
    }
    case "item": {
      const slot = findSlot(sheet.slotId);
      const variant = slot?.variants.find((entry) => entry.lineageId === sheet.variantId);
      if (slot === null || variant === undefined) return null;
      const index = variant.items.findIndex((item) => item.lineageId === sheet.item.lineageId);
      const exercise = catalog.exercises.find((entry) => entry.id === sheet.item.exerciseId) ?? readExercise(sheet.item.exerciseId);
      return (
        <Sheet open={open} title={exercise?.name ?? "Exercice"} context={placeOf(slot.lineageId, variant.lineageId)} onClose={close}>
          <ItemSheet
            key={`${sheet.item.lineageId}-${sheet.item.exerciseId}`}
            item={sheet.item}
            exercise={exercise}
            zones={catalog.zones.get(sheet.item.exerciseId) ?? []}
            isNew={sheet.isNew}
            canMoveUp={index > 0}
            canMoveDown={index >= 0 && index < variant.items.length - 1}
            onChangeExercise={(item) => show({ kind: "picker", purpose: { slotId: slot.lineageId, variantId: variant.lineageId, item, isNew: sheet.isNew }, query: "" })}
            onSave={(item) => {
              dispatch({ type: "save_item", slotId: slot.lineageId, variantId: variant.lineageId, item });
              close();
            }}
            onMove={(offset) => dispatch({ type: "move_item", slotId: slot.lineageId, variantId: variant.lineageId, itemId: sheet.item.lineageId, offset })}
            onRemove={() => {
              dispatch({ type: "remove_item", slotId: slot.lineageId, variantId: variant.lineageId, itemId: sheet.item.lineageId });
              close();
            }}
          />
        </Sheet>
      );
    }
    case "discard":
      return (
        <Sheet
          open={open}
          title="Abandonner les modifications ?"
          context={props.isNew ? "Le programme ne sera pas créé" : `${plural(props.changesCount, "modification perdue", "modifications perdues")}`}
          onClose={close}
        >
          <Choices
            items={[
              { value: "keep", label: "Continuer à modifier" },
              { value: "discard", label: "Abandonner" },
            ]}
            onChoose={(choice) => (choice === "discard" ? props.onDiscard() : close())}
          />
        </Sheet>
      );
    default: {
      const unreachable: never = sheet;
      return unreachable;
    }
  }
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  appbar: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 44 },
  context: { flex: 1 },
  missing: { marginTop: 20 },
  name: {
    marginTop: 14,
    height: 56,
    paddingHorizontal: 14,
    borderRadius: radii.control,
    borderWidth: layout.borderControl,
    fontFamily: fonts.text700,
    fontSize: 22,
  },
  frequency: { marginTop: 20, flexDirection: "row", alignItems: "center", gap: 12 },
  frequencyLabel: { flex: 1 },
  frequencyStepper: { width: 176 },
  emptyRotation: { paddingVertical: 14 },
  add: { marginTop: 10 },
  changes: { marginTop: 20, gap: 4 },
  changeCount: { fontFamily: fonts.text700 },
  stale: { gap: 2 },
  staleLink: { alignSelf: "flex-start", marginLeft: -10 },
  bottom: { position: "absolute", left: 0, right: 0, bottom: 0, paddingTop: 10, paddingHorizontal: layout.gutter, borderTopWidth: 1 },
});
