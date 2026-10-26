import { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { eq } from "drizzle-orm";
import { useLiveQuery } from "drizzle-orm/expo-sqlite";
import { climbDefaults, findOpenSession, planClimbStart } from "@obnixe/core";
import { programSlot, session, sports } from "@obnixe/schema";
import type { Id, Session } from "@obnixe/schema";
import { db, environment } from "@/data/database";
import { write } from "@/data/write";
import { ClimbScreen } from "@/features/activity/ClimbScreen";
import { deviceTimeZone } from "@/features/activity/format";
import { LinkButton, PrimaryButton } from "@/ui/Button";
import { IconButton } from "@/ui/Inputs";
import { Screen } from "@/ui/Layout";
import { Text } from "@/ui/Text";

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function ClimbRoute() {
  const params = useLocalSearchParams<{ id: string; slotId?: string; variantId?: string }>();
  const id = single(params.id) ?? "new";
  return id === "new" ? <NewClimb slotId={single(params.slotId) ?? null} variantId={single(params.variantId) ?? null} /> : <ExistingClimb id={id as Id} />;
}

interface NewClimbProps {
  readonly slotId: string | null;
  readonly variantId: string | null;
}

function NewClimb({ slotId, variantId }: NewClimbProps) {
  const router = useRouter();
  const started = useRef(false);
  const [blocking, setBlocking] = useState<Session | null>(null);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const open = findOpenSession(db());
    if (open !== null) {
      if (open.sport === "climb") router.replace({ pathname: "/climb/[id]", params: { id: open.id } });
      else setBlocking(open);
      return;
    }
    const slot = slotId === null ? undefined : db().select({ id: programSlot.id, sport: programSlot.sport }).from(programSlot).where(eq(programSlot.id, slotId as Id)).get();
    const defaults = climbDefaults(db());
    const plan = planClimbStart(db(), environment, {
      startedAt: environment.now(),
      timeZone: deviceTimeZone(),
      discipline: defaults.discipline,
      place: defaults.place,
      slot: slot === undefined || slot.sport !== "climb" ? null : { slotId: slot.id, variantId: variantId as Id | null, countsInRotation: true },
    });
    write("Séance d'escalade commencée", [plan.mutation]);
    router.replace({ pathname: "/climb/[id]", params: { id: plan.sessionId } });
  }, [router, slotId, variantId]);

  if (blocking === null) return null;
  return <OpenElsewhere open={blocking} />;
}

interface OpenElsewhereProps {
  readonly open: Session;
}

function OpenElsewhere({ open }: OpenElsewhereProps) {
  const router = useRouter();
  const close = (): void => {
    if (router.canGoBack()) router.back();
    else router.replace("/");
  };
  const resume = (): void => {
    if (open.sport === "strength") router.replace({ pathname: "/workout/[id]", params: { id: open.id } });
    else router.replace({ pathname: "/session/[id]", params: { id: open.id } });
  };
  return (
    <Screen>
      <View style={styles.appbar}>
        <IconButton icon="close" label="Fermer" edge="start" onPress={close} />
      </View>
      <Text variant="title" accessibilityRole="header" style={styles.title}>
        Une séance est déjà en cours
      </Text>
      <Text variant="body" tone="secondary" style={styles.body}>
        {sports[open.sport].label} commencée plus tôt. Termine-la avant d'en lancer une autre.
      </Text>
      <PrimaryButton label="Reprendre la séance" onPress={resume} style={styles.action} />
      <View style={styles.link}>
        <LinkButton label="Fermer" onPress={close} />
      </View>
    </Screen>
  );
}

interface ExistingClimbProps {
  readonly id: Id;
}

function ExistingClimb({ id }: ExistingClimbProps) {
  const router = useRouter();
  const { data, updatedAt } = useLiveQuery(db().select().from(session).where(eq(session.id, id)), [id]);
  const current = data[0];
  const completed = current !== undefined && current.status === "completed";

  useEffect(() => {
    if (completed) router.replace({ pathname: "/session/[id]", params: { id } });
  }, [completed, id, router]);

  if (updatedAt === undefined || completed) return null;
  if (current === undefined || current.sport !== "climb" || current.deletedAt !== null) {
    return (
      <Screen>
        <View style={styles.appbar}>
          <IconButton icon="close" label="Fermer" edge="start" onPress={() => router.replace("/")} />
        </View>
        <Text variant="title" accessibilityRole="header" style={styles.title}>
          Séance introuvable
        </Text>
      </Screen>
    );
  }
  return <ClimbScreen current={current} />;
}

const styles = StyleSheet.create({
  appbar: { flexDirection: "row", alignItems: "center", minHeight: 44 },
  title: { marginTop: 14 },
  body: { marginTop: 8 },
  action: { marginTop: 24 },
  link: { alignItems: "center", marginTop: 8 },
});
