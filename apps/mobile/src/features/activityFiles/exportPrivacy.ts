import { isNull } from "drizzle-orm";
import { useLiveQuery } from "drizzle-orm/expo-sqlite";
import { privacyZone, settings } from "@obnixe/schema";
import { db } from "@/data/database";
import { plural } from "@/format/labels";
import { formatInteger } from "@/format/numbers";

export interface ExportPrivacy {
  /** Zones or hidden ends would change the exported track. */
  readonly masks: boolean;
  /** What « Inclure la trace complète » would show. */
  readonly detail: string;
  /** The box starts unchecked while the zones apply to exports (`PRV-011`). */
  readonly includeFullTrack: boolean;
}

function maskDetail(zones: number, hideEndsMeters: number): string {
  const parts = [...(zones === 0 ? [] : [plural(zones, "zone de confidentialité", "zones de confidentialité")]), ...(hideEndsMeters === 0 ? [] : [`${formatInteger(hideEndsMeters)} m au début et à la fin`])];
  return `Sinon masqués : ${parts.join(", ")}`;
}

export function useExportPrivacy(): ExportPrivacy | null {
  const { data: settingsRows } = useLiveQuery(db().select({ exportPrivacy: settings.exportPrivacy, hideTrackEndsMeters: settings.hideTrackEndsMeters }).from(settings));
  const { data: zones } = useLiveQuery(db().select({ id: privacyZone.id }).from(privacyZone).where(isNull(privacyZone.deletedAt)));
  const current = settingsRows[0];
  if (current === undefined) return null;
  return {
    masks: zones.length > 0 || current.hideTrackEndsMeters > 0,
    detail: maskDetail(zones.length, current.hideTrackEndsMeters),
    includeFullTrack: !current.exportPrivacy,
  };
}
