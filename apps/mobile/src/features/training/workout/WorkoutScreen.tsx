import { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { asc, eq } from "drizzle-orm";
import {
  finishMutations,
  isResumable,
  loadWorkout,
  nextSlot,
  NotStrengthSlotError,
  openSession,
  resumeMutations,
  SlotNotFoundError,
  startWorkoutMutations,
  VariantNotInSlotError,
} from "@obnixe/core";
import { programSlot, programVariant } from "@obnixe/schema";
import type { Id, Session } from "@obnixe/schema";
import { db, environment } from "@/data/database";
import { write } from "@/data/write";
import { deviceTimeZone, useLiveLoad } from "@/features/training/useLiveLoad";
import { LiveWorkoutScreen } from "@/features/training/workout/LiveWorkoutScreen";
import { loadLiveWorkout } from "@/features/training/workout/liveWorkout";
import { LinkButton, PrimaryButton } from "@/ui/Button";
import { IconButton } from "@/ui/Inputs";
import { AppBar, Screen } from "@/ui/Layout";
import { Text } from "@/ui/Text";

interface WorkoutScreenProps {
  readonly id: string;
}

export function WorkoutScreen({ id }: WorkoutScreenProps) {
  if (id === "new") return <StartWorkout />;
  return <WorkoutGate sessionId={id as Id} />;
}

function goBack(): void {
  if (router.canGoBack()) router.back();
  else router.replace("/");
}

function openSessionHref(session: Session): void {
  switch (session.sport) {
    case "strength":
      router.replace({ pathname: "/workout/[id]", params: { id: session.id } });
      return;
    case "climb":
      router.replace({ pathname: "/climb/[id]", params: { id: session.id } });
      return;
    case "run":
    case "hike":
    case "swim":
    case "bike":
    case "yoga":
      router.replace({ pathname: "/session/[id]", params: { id: session.id } });
      return;
    default: {
      const unreachable: never = session.sport;
      return unreachable;
    }
  }
}

type StartOutcome = { readonly kind: "opened" } | { readonly kind: "nothing" } | { readonly kind: "invalid" };

function startOrResume(slotParam: string | undefined, variantParam: string | undefined): StartOutcome {
  const now = environment.now();
  const open = openSession(db());
  if (open !== null) {
    if (open.status === "in_progress" || isResumable(open, now)) {
      openSessionHref(open);
      return { kind: "opened" };
    }
    const stale = loadWorkout(db(), open.id);
    if (stale !== null) write("Séance close", finishMutations(stale, now));
  }
  let slotId = slotParam as Id | undefined;
  let variantId = variantParam as Id | undefined;
  if (slotId === undefined) {
    const upcoming = nextSlot(db());
    if (upcoming === null || upcoming.slot.sport !== "strength") return { kind: "nothing" };
    slotId = upcoming.slot.id;
    variantId = upcoming.variants[0]?.id;
  }
  if (variantId === undefined) {
    variantId = db().select({ id: programVariant.id }).from(programVariant).where(eq(programVariant.slotId, slotId)).orderBy(asc(programVariant.position)).get()?.id;
  }
  if (variantId === undefined) return { kind: "invalid" };
  try {
    const started = startWorkoutMutations(db(), environment.newId, { slotId, variantId, now, timeZone: deviceTimeZone() });
    const slotName = db().select({ name: programSlot.name }).from(programSlot).where(eq(programSlot.id, slotId)).get()?.name ?? "Séance";
    write(`${slotName} commencée`, started.mutations);
    router.replace({ pathname: "/workout/[id]", params: { id: started.sessionId } });
    return { kind: "opened" };
  } catch (error) {
    if (error instanceof SlotNotFoundError || error instanceof VariantNotInSlotError || error instanceof NotStrengthSlotError) return { kind: "invalid" };
    throw error;
  }
}

function StartWorkout() {
  const { slotId, variantId } = useLocalSearchParams<{ slotId?: string; variantId?: string }>();
  const started = useRef(false);
  const [outcome, setOutcome] = useState<StartOutcome | null>(null);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    setOutcome(startOrResume(slotId, variantId));
  }, [slotId, variantId]);

  if (outcome === null || outcome.kind === "opened") return null;
  return (
    <Message
      title={outcome.kind === "nothing" ? "Aucune séance prévue" : "Séance introuvable"}
      detail={outcome.kind === "nothing" ? "Le programme actif n'a pas de séance de musculation à suivre." : "Ce créneau n'existe plus dans le programme."}
      action={outcome.kind === "nothing" ? { label: "Voir les programmes", run: () => router.replace("/programs") } : null}
    />
  );
}

type GateState = "missing" | "completed" | "resume" | "expired" | "live";

function WorkoutGate({ sessionId }: WorkoutGateProps) {
  const live = useLiveLoad(() => loadLiveWorkout(sessionId), [sessionId]);
  const session = live?.data.session ?? null;
  const state: GateState = (() => {
    if (session === null || session.deletedAt !== null || session.sport !== "strength") return "missing";
    switch (session.status) {
      case "completed":
        return "completed";
      case "interrupted":
        return isResumable(session, environment.now()) ? "resume" : "expired";
      case "in_progress":
        return "live";
      default: {
        const unreachable: never = session.status;
        return unreachable;
      }
    }
  })();

  useEffect(() => {
    if (session === null) return;
    if (state === "resume") write("Séance reprise", resumeMutations(session, environment.now()));
    if (state === "completed") router.replace({ pathname: "/session/[id]", params: { id: session.id } });
  }, [state, session]);

  switch (state) {
    case "missing":
      return <Message title="Séance introuvable" detail="Elle a été supprimée ou n'existe pas." action={null} />;
    case "completed":
    case "resume":
      return null;
    case "expired":
      return (
        <Message
          title="Séance interrompue"
          detail="La reprise n'est possible que jusqu'à 6 h le lendemain. Les séries enregistrées sont conservées."
          action={{
            label: "Faire le bilan",
            run: () => {
              if (live === null) return;
              write("Séance terminée", finishMutations(live.data, environment.now()));
              router.replace({ pathname: "/session/[id]/review", params: { id: sessionId } });
            },
          }}
        />
      );
    case "live":
      return live === null ? null : <LiveWorkoutScreen live={live} />;
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
}

interface WorkoutGateProps {
  readonly sessionId: Id;
}

interface MessageProps {
  readonly title: string;
  readonly detail: string;
  readonly action: { readonly label: string; readonly run: () => void } | null;
}

function Message({ title, detail, action }: MessageProps) {
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
