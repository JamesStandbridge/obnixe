import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { durationFromDigits, formatDigitsAsClock } from "@/features/activity/format";
import { LinkButton, SheetButton } from "@/ui/Button";
import { NumberPad, parsePadValue } from "@/ui/Inputs";
import { Sheet } from "@/ui/Overlays";

export type PadMode = "number" | "clock";

export type PadResult = { readonly kind: "keep" } | { readonly kind: "value"; readonly value: number };

interface PadSheetProps {
  readonly open: boolean;
  readonly title: string;
  readonly context?: string;
  readonly mode: PadMode;
  readonly unit: string;
  readonly decimals: number;
  readonly current: string | null;
  readonly validate?: (value: number) => string | null;
  readonly removeLabel?: string;
  readonly onSubmit: (result: PadResult) => void;
  readonly onRemove?: () => void;
  readonly onClose: () => void;
}

export function PadSheet({ open, title, context, mode, unit, decimals, current, validate, removeLabel, onSubmit, onRemove, onClose }: PadSheetProps) {
  const [buffer, setBuffer] = useState("");

  useEffect(() => {
    if (open) setBuffer("");
  }, [open]);

  const clock = mode === "clock";
  const parsed = buffer === "" ? null : clock ? durationFromDigits(buffer) : parsePadValue(buffer);
  const display = clock ? formatDigitsAsClock(buffer) : buffer;
  const warning = parsed === null || validate === undefined ? null : validate(parsed);
  const invalid = parsed === null ? buffer !== "" : warning !== null || (clock && parsed <= 0);
  const label = buffer === "" ? (current === null ? "Utiliser" : `Garder ${current}`) : `Utiliser ${display}`;

  return (
    <Sheet open={open} title={title} {...(context === undefined ? {} : { context })} onClose={onClose}>
      <NumberPad
        value={buffer}
        unit={unit}
        placeholder={current ?? (clock ? "0:00" : "0")}
        decimals={clock ? 0 : decimals}
        {...(clock ? { format: formatDigitsAsClock } : {})}
        {...(warning === null ? {} : { warning })}
        onChange={setBuffer}
      />
      <SheetButton
        label={label}
        disabled={(buffer === "" && current === null) || invalid}
        style={styles.confirm}
        onPress={() => {
          if (parsed === null) {
            if (current !== null) onSubmit({ kind: "keep" });
            return;
          }
          onSubmit({ kind: "value", value: parsed });
        }}
      />
      {onRemove === undefined || removeLabel === undefined ? null : (
        <View style={styles.remove}>
          <LinkButton label={removeLabel} onPress={onRemove} />
        </View>
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  confirm: { marginTop: 14 },
  remove: { alignItems: "center", marginTop: 8 },
});
