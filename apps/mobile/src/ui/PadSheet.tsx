import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { ControlButton, LinkButton, SheetButton } from "@/ui/Button";
import { NumberPad, parsePadValue } from "@/ui/Inputs";
import { Sheet } from "@/ui/Overlays";

export type PadMode = "number" | "clock";

export type PadResult = { readonly kind: "keep" } | { readonly kind: "value"; readonly value: number };

export interface PadEntry {
  readonly buffer: string;
  readonly display: string;
  readonly value: number | null;
}

export type PadActionAppearance = "link" | "control";

export interface PadAction {
  readonly label: string;
  readonly appearance: PadActionAppearance;
  readonly onPress: () => void;
}

interface PadSheetProps {
  readonly open: boolean;
  readonly title: string;
  readonly context?: string;
  readonly mode: PadMode;
  readonly unit: string;
  readonly decimals: number;
  readonly maxLength?: number;
  /** Shown as the placeholder; when set, confirming an empty pad keeps it. */
  readonly current: string | null;
  readonly initialBuffer?: string;
  /** A returned message blocks confirmation. */
  readonly validate?: (value: number) => string | null;
  /** A returned message is only informative. */
  readonly hint?: (entry: PadEntry) => string | null;
  readonly confirmLabel?: (entry: PadEntry) => string;
  readonly action?: PadAction;
  readonly onSubmit: (result: PadResult) => void;
  readonly onClose: () => void;
}

function durationFromDigits(digits: string): number {
  const padded = digits.padStart(6, "0");
  const hours = Number(padded.slice(0, -4));
  const minutes = Number(padded.slice(-4, -2));
  const seconds = Number(padded.slice(-2));
  return hours * 3600 + minutes * 60 + seconds;
}

function formatDigitsAsClock(digits: string): string {
  const padded = digits.padStart(4, "0");
  const hours = padded.slice(0, -4);
  const minutes = padded.slice(-4, -2);
  const seconds = padded.slice(-2);
  return hours === "" ? `${Number(minutes)}:${seconds}` : `${Number(hours)}:${minutes}:${seconds}`;
}

function defaultConfirmLabel(entry: PadEntry, current: string | null): string {
  if (entry.buffer !== "") return `Utiliser ${entry.display}`;
  return current === null ? "Utiliser" : `Garder ${current}`;
}

function ActionButton({ label, appearance, onPress }: PadAction) {
  switch (appearance) {
    case "link":
      return (
        <View style={styles.linkAction}>
          <LinkButton label={label} onPress={onPress} />
        </View>
      );
    case "control":
      return <ControlButton label={label} onPress={onPress} style={styles.controlAction} />;
    default: {
      const unreachable: never = appearance;
      return unreachable;
    }
  }
}

export function PadSheet({ open, title, context, mode, unit, decimals, maxLength, current, initialBuffer = "", validate, hint, confirmLabel, action, onSubmit, onClose }: PadSheetProps) {
  const [buffer, setBuffer] = useState(initialBuffer);

  useEffect(() => {
    if (open) setBuffer(initialBuffer);
  }, [open, initialBuffer]);

  const clock = mode === "clock";
  const value = buffer === "" ? null : clock ? durationFromDigits(buffer) : parsePadValue(buffer);
  const entry: PadEntry = { buffer, display: clock ? formatDigitsAsClock(buffer) : buffer, value };
  const blocking = value === null || validate === undefined ? null : validate(value);
  const warning = blocking ?? (hint === undefined ? null : hint(entry));
  const invalid = value === null ? buffer !== "" : blocking !== null || (clock && value <= 0);

  return (
    <Sheet open={open} title={title} {...(context === undefined ? {} : { context })} onClose={onClose}>
      <NumberPad
        value={buffer}
        unit={unit}
        placeholder={current ?? (clock ? "0:00" : "0")}
        decimals={clock ? 0 : decimals}
        {...(maxLength === undefined ? {} : { maxLength })}
        {...(clock ? { format: formatDigitsAsClock } : {})}
        {...(warning === null ? {} : { warning })}
        onChange={setBuffer}
      />
      <SheetButton
        label={confirmLabel === undefined ? defaultConfirmLabel(entry, current) : confirmLabel(entry)}
        disabled={(buffer === "" && current === null) || invalid}
        style={styles.confirm}
        onPress={() => {
          if (value === null) {
            if (current !== null) onSubmit({ kind: "keep" });
            return;
          }
          onSubmit({ kind: "value", value });
        }}
      />
      {action === undefined ? null : <ActionButton {...action} />}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  confirm: { marginTop: 14 },
  linkAction: { alignItems: "center", marginTop: 8 },
  controlAction: { marginTop: 10 },
});
