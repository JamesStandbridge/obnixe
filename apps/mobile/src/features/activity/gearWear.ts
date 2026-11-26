import { useCallback } from "react";
import { gearWearAlert, retireGear, setGearWear } from "@obnixe/core";
import type { GearWearAlert } from "@obnixe/core";
import type { Gear, Id } from "@obnixe/schema";
import { db, environment } from "@/data/database";
import { useUndoableWrite, write } from "@/data/write";
import { formatKilometers } from "@/features/activity/presentation";
import { useSnackbar } from "@/ui/SnackbarHost";

/** Stores the threshold chosen in the gear sheet (`INT-011`); false when nothing changed. */
export function writeGearWear(item: Gear, wearMeters: number | null): boolean {
  const mutation = setGearWear(item, wearMeters);
  if (mutation === null) return false;
  write(wearMeters === null ? `Seuil d'usure retiré : ${item.name}` : `Seuil d'usure de ${item.name} : ${formatKilometers(wearMeters)}`, [mutation]);
  return true;
}

export function gearWearText(alert: GearWearAlert): string {
  return `${alert.gear.name} a atteint ${formatKilometers(alert.meters)}, son seuil d'usure est de ${formatKilometers(alert.wearMeters)}.`;
}

/** Retires the worn gear, undoable; it is then no longer offered for the next activities. */
export function useRetireGear(): (alert: GearWearAlert) => void {
  const undoableWrite = useUndoableWrite();
  return useCallback(
    (alert: GearWearAlert) => {
      undoableWrite({ summary: `Matériel retiré : ${alert.gear.name}`, mutations: [retireGear(alert.gear.id, environment.now())], message: "Matériel retiré" });
    },
    [undoableWrite],
  );
}

/** `INT-011` after a logged activity: a snackbar when it carried its gear past the wear threshold. */
export function useGearWearNotice(): (sessionId: Id) => void {
  const notify = useSnackbar();
  const retire = useRetireGear();
  return useCallback(
    (sessionId: Id) => {
      const alert = gearWearAlert(db(), sessionId);
      if (alert === null) return;
      notify({ text: `Usure atteinte : ${alert.gear.name}, ${formatKilometers(alert.meters)}`, action: { label: "Retirer", run: () => retire(alert) } });
    },
    [notify, retire],
  );
}
