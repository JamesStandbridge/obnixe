import { getRandomValues } from "expo-crypto";
import { drawMaskScalePermille, newPrivacyZone, recordZoneProposal } from "@obnixe/core";
import type { PrivacyZonePlan, ZoneProposal } from "@obnixe/core";
import { db, environment } from "@/data/database";

/**
 * `PRV-014` after a save: *Créer la zone* commits the returned plan's mutation, then `settleZoneProposal`; *Non merci*
 * only settles it. Either way the place is never offered again.
 */
export function zoneFromProposal(proposal: ZoneProposal, label: string): PrivacyZonePlan {
  const maskScale = drawMaskScalePermille(() => new DataView(getRandomValues(new Uint8Array(4)).buffer).getUint32(0) / 2 ** 32);
  return newPrivacyZone(environment, { label, center: proposal.center, radiusMeters: proposal.radiusMeters }, maskScale);
}

export function settleZoneProposal(proposal: ZoneProposal): void {
  recordZoneProposal(db(), environment, proposal);
}
