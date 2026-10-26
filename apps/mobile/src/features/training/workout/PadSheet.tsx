import { useEffect, useState } from "react";
import { StyleSheet } from "react-native";
import { SheetButton } from "@/ui/Button";
import { NumberPad, parsePadValue } from "@/ui/Inputs";
import { Sheet } from "@/ui/Overlays";
import { formatNumber, formatSigned } from "@/format/numbers";

export interface PadRequest {
  readonly title: string;
  readonly unit: string;
  readonly decimals: number;
  readonly current: number;
  readonly previous: number | null;
  readonly max: number;
}

interface PadSheetProps {
  readonly request: PadRequest | null;
  readonly onClose: () => void;
  readonly onConfirm: (value: number) => void;
}

const warnAboveRatio = 0.2;

export function PadSheet({ request, onClose, onConfirm }: PadSheetProps) {
  const [buffer, setBuffer] = useState("");
  const [shown, setShown] = useState<PadRequest | null>(request);
  useEffect(() => {
    if (request === null) return;
    setShown(request);
    setBuffer("");
  }, [request]);

  if (shown === null) return null;
  const typed = parsePadValue(buffer);
  const value = Math.min(shown.max, typed ?? shown.current);
  const delta = shown.previous === null ? 0 : Math.round((value - shown.previous) * 10) / 10;
  const warning = shown.previous !== null && shown.previous > 0 && Math.abs(delta) / shown.previous > warnAboveRatio ? `${formatSigned(delta, shown.decimals)} ${shown.unit} vs la dernière fois` : undefined;
  return (
    <Sheet open={request !== null} title={shown.title} onClose={onClose}>
      <NumberPad
        value={buffer}
        unit={shown.unit}
        placeholder={formatNumber(shown.current, shown.decimals)}
        decimals={shown.decimals}
        maxLength={shown.decimals === 0 ? 4 : 5}
        onChange={setBuffer}
        {...(warning === undefined ? {} : { warning })}
      />
      <SheetButton label={`Utiliser ${formatNumber(value, shown.decimals)} ${shown.unit}`} onPress={() => onConfirm(value)} style={styles.confirm} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  confirm: { marginTop: 14 },
});
