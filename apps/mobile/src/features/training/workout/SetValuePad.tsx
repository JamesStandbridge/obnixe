import { useEffect, useState } from "react";
import { formatNumber, formatSigned } from "@/format/numbers";
import { PadSheet } from "@/ui/PadSheet";
import type { PadEntry } from "@/ui/PadSheet";

export interface PadRequest {
  readonly title: string;
  readonly unit: string;
  readonly decimals: number;
  readonly current: number;
  readonly previous: number | null;
  readonly max: number;
}

interface SetValuePadProps {
  readonly request: PadRequest | null;
  readonly onClose: () => void;
  readonly onConfirm: (value: number) => void;
}

const warnAboveRatio = 0.2;

export function SetValuePad({ request, onClose, onConfirm }: SetValuePadProps) {
  const [shown, setShown] = useState<PadRequest | null>(request);
  useEffect(() => {
    if (request !== null) setShown(request);
  }, [request]);

  if (shown === null) return null;
  const valueOf = (entry: PadEntry): number => Math.min(shown.max, entry.value ?? shown.current);
  return (
    <PadSheet
      open={request !== null}
      title={shown.title}
      mode="number"
      unit={shown.unit}
      decimals={shown.decimals}
      maxLength={shown.decimals === 0 ? 4 : 5}
      current={formatNumber(shown.current, shown.decimals)}
      hint={(entry) => {
        if (shown.previous === null || shown.previous <= 0) return null;
        const delta = Math.round((valueOf(entry) - shown.previous) * 10) / 10;
        return Math.abs(delta) / shown.previous > warnAboveRatio ? `${formatSigned(delta, shown.decimals)} ${shown.unit} vs la dernière fois` : null;
      }}
      confirmLabel={(entry) => `Utiliser ${formatNumber(valueOf(entry), shown.decimals)} ${shown.unit}`}
      onSubmit={(result) => onConfirm(Math.min(shown.max, result.kind === "value" ? result.value : shown.current))}
      onClose={onClose}
    />
  );
}
