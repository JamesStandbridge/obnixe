import { useEffect, useRef, useState } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { asc, eq } from "drizzle-orm";
import {
  finishMutations,
  isResumable,
  loadWorkout,
  nextSlot,
  NotStrengthSlotError,
  openSessionRow,
  resumeMutations,
  SlotNotFoundError,
  startFreeWorkoutMutations,
  startWorkoutMutations,
  VariantNotInSlotError,
} from "@obnixe/core";
import { programSlot, programVariant } from "@obnixe/schema";
import type { Id, Session } from "@obnixe/schema";
import { db, environment } from "@/data/database";
import { write } from "@/data/write";
import { Message } from "@/features/training/Message";
import { freeStrengthTitle } from "@/format/labels";
import { useLiveLoad } from "@/features/training/useLiveLoad";
import { deviceTimeZone } from "@/format/dates";
import { LiveWorkoutScreen } from "@/features/training/workout/LiveWorkoutScreen";
import { loadLiveWorkout } from "@/features/training/workout/liveWorkout";
import { cancelRestAlert } from "@/features/training/workout/restAlert";

interface WorkoutScreenProps {
  readonly id: string;
}

export function WorkoutScreen({ id }: WorkoutScreenProps) {
  if (id === "new") return <StartWorkout />;
  return <WorkoutGate sessionId={id as Id} />;
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

interface StartParams {
  readonly free: boolean;
  readonly slotId: string | undefined;
  readonly variantId: string | undefined;
}

function startOrResume(params: StartParams): StartOutcome {
  const now = environment.now();
  const open = openSessionRow(db());
  if (open !== null) {
    if (open.status === "in_progress" || isResumable(open, now)) {
      openSessionHref(open);
      return { kind: "opened" };
    }
    const stale = loadWorkout(db(), open.id);
    if (stale !== null) {
      cancelRestAlert();
      write("Séance close", finishMutations(stale, now));
    }
  }
  if (params.free) {
    const started = startFreeWorkoutMutations(environment.newId, { now, timeZone: deviceTimeZone() });
    write(`${freeStrengthTitle} commencée`, started.mutations);
    router.replace({ pathname: "/workout/[id]", params: { id: started.sessionId } });
    return { kind: "opened" };
  }
  let slotId = params.slotId as Id | undefined;
  let variantId = params.variantId as Id | undefined;
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
  const { free, slotId, variantId } = useLocalSearchParams<{ free?: string; slotId?: string; variantId?: string }>();
  const started = useRef(false);
  const [outcome, setOutcome] = useState<StartOutcome | null>(null);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    setOutcome(startOrResume({ free: free === "1", slotId, variantId }));
  }, [free, slotId, variantId]);

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

interface WorkoutGateProps {
  readonly sessionId: Id;
}

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

  const completedOnOpen = useRef(state === "completed");
  const resumedFrom = useRef<number | null>(null);
  useEffect(() => {
    if (session === null) return;
    if (state === "resume" && resumedFrom.current !== session.endedAt) {
      resumedFrom.current = session.endedAt;
      write("Séance reprise", resumeMutations(session, environment.now()));
    }
    if (state === "completed" && completedOnOpen.current) router.replace({ pathname: "/session/[id]", params: { id: session.id } });
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
              cancelRestAlert();
              write("Séance terminée", finishMutations(live.data, environment.now()));
              router.replace({ pathname: "/session/[id]/review", params: { id: sessionId, attach: "1" } });
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
