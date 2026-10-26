import { useCallback } from "react";
import { StyleSheet, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { callTag, historyTitle, readsLine, revertState } from "@obnixe/core";
import type { RevertIndex } from "@obnixe/core";
import type { AgentConnection } from "@obnixe/schema";
import { ActivityRow, AgentAppBar, Heading } from "@/features/agent/components";
import { deviceTimeZone, formatTimeAt, weekdayTitle } from "@/format/dates";
import { markAgentChangesSeen, useCalls, useConnections, useRevertIndex } from "@/features/agent/queries";
import type { CallRow } from "@/features/agent/queries";
import { useToggleChange } from "@/features/agent/useToggleChange";
import type { ToggleTarget } from "@/features/agent/useToggleChange";
import { Section, Screen } from "@/ui/Layout";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { goBack } from "@/ui/navigation";

interface ConnectionSectionProps {
  readonly connection: AgentConnection;
  readonly calls: readonly CallRow[];
  readonly index: RevertIndex;
  readonly onToggle: (target: ToggleTarget) => void;
}

function ConnectionSection({ connection, calls, index, onToggle }: ConnectionSectionProps) {
  const { colors } = useTheme();
  const span = connection.endedAt === null ? `depuis ${formatTimeAt(connection.startedAt, deviceTimeZone())}` : `${formatTimeAt(connection.startedAt, deviceTimeZone())} – ${formatTimeAt(connection.endedAt, deviceTimeZone())}`;
  const reads = readsLine(calls);
  const writes = calls.filter((call) => call.kind === "write");
  return (
    <Section
      title={weekdayTitle(connection.startedAt, deviceTimeZone())}
      action={
        <Text variant="small" tone="secondary">
          {connection.client} · {span}
        </Text>
      }
    >
      {reads === null && writes.length === 0 ? (
        <Text variant="small" tone="secondary" style={styles.reads}>
          Aucun accès
        </Text>
      ) : null}
      {reads === null ? null : (
        <Text variant="small" tone="secondary" style={[styles.reads, { borderBottomColor: colors.line, borderBottomWidth: writes.length === 0 ? 0 : 1 }]}>
          {reads}
        </Text>
      )}
      {writes.map((call, position) => {
        const changesetId = call.changesetId;
        const reverted = changesetId !== null && revertState(index, changesetId).reverted;
        return (
          <ActivityRow
            key={call.id}
            wide
            time={formatTimeAt(call.calledAt, deviceTimeZone())}
            tag={callTag(call)}
            title={historyTitle(call)}
            tool={null}
            reverted={reverted}
            onToggle={changesetId === null ? null : () => onToggle({ changesetId, summary: call.summary })}
            last={position === writes.length - 1}
          />
        );
      })}
    </Section>
  );
}

export default function AgentLog() {
  const connections = useConnections();
  const calls = useCalls(null);
  const index = useRevertIndex();
  const toggle = useToggleChange(0);

  useFocusEffect(
    useCallback(() => {
      markAgentChangesSeen();
      return () => markAgentChangesSeen();
    }, []),
  );

  return (
    <View style={styles.root}>
      <Screen>
        <AgentAppBar onBack={() => goBack("/agent")} />
        <Heading title="Activité des agents" />
        {connections.length === 0 ? (
          <Text tone="secondary" style={styles.empty}>
            Aucun agent ne s'est encore connecté.
          </Text>
        ) : (
          connections.map((connection) => (
            <ConnectionSection key={connection.id} connection={connection} calls={calls.filter((call) => call.connectionId === connection.id)} index={index} onToggle={toggle} />
          ))
        )}
      </Screen>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  reads: { paddingVertical: 10 },
  empty: { marginTop: 12, lineHeight: 23 },
});
