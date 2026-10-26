import { useMemo } from "react";
import { desc, isNotNull, isNull } from "drizzle-orm";
import { useLiveQuery } from "drizzle-orm/expo-sqlite";
import { checkIn, measurement, measurementKind, painReport, photo, weighIn, zoneTracking } from "@obnixe/schema";
import { db } from "@/data/database";
import { useMassUnit } from "@/data/settings";
import { CheckInsSection } from "@/features/body/CheckInsSection";
import { MeasurementsSection } from "@/features/body/MeasurementsSection";
import { PhotosSection } from "@/features/body/PhotosSection";
import { WeightSection } from "@/features/body/WeightSection";
import { AppBar, Screen } from "@/ui/Layout";

export function BodyScreen() {
  const massUnit = useMassUnit();
  const { data: weighIns } = useLiveQuery(db().select().from(weighIn).where(isNull(weighIn.deletedAt)).orderBy(desc(weighIn.localDate)));
  const { data: kinds } = useLiveQuery(db().select().from(measurementKind));
  const { data: measurements } = useLiveQuery(db().select().from(measurement).where(isNull(measurement.deletedAt)));
  const { data: photos } = useLiveQuery(db().select().from(photo).where(isNull(photo.deletedAt)));
  const { data: checkIns } = useLiveQuery(db().select().from(checkIn).where(isNull(checkIn.deletedAt)).orderBy(desc(checkIn.localDate)).limit(7));
  const { data: checkInPains } = useLiveQuery(db().select().from(painReport).where(isNotNull(painReport.checkInId)));
  const { data: tracking } = useLiveQuery(db().select({ zone: zoneTracking.zone }).from(zoneTracking).where(isNull(zoneTracking.endedAt)));
  const tracked = useMemo(() => tracking.map((row) => row.zone), [tracking]);

  return (
    <Screen>
      <AppBar title="Corps" />
      <WeightSection weighIns={weighIns} massUnit={massUnit}>
        <MeasurementsSection kinds={kinds} measurements={measurements} />
        <PhotosSection photos={photos} />
        <CheckInsSection checkIns={checkIns} pains={checkInPains} tracked={tracked} />
      </WeightSection>
    </Screen>
  );
}
