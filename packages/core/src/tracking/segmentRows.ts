import { and, asc, eq, gte, inArray, isNotNull, lte } from "drizzle-orm";
import { recording, segment, segmentDerivation, segmentEffort, session } from "@obnixe/schema";
import type { BoundingBoxE7, Id, Segment, SportKey } from "@obnixe/schema";
import type { ObnixeDatabase } from "../database.ts";
import { boxesOverlap } from "./geo.ts";
import type { SessionRecording } from "./plans.ts";
import { segmentFamilyOf, segmentSearchBox, segmentShape } from "./segments.ts";
import type { SegmentShape } from "./segments.ts";

/** Changes exactly when the efforts found on a segment would; stored with its sweep. */
export function segmentShapeKey(row: Pick<Segment, "family" | "distanceMm" | "polyline">): string {
  return `${row.family};${row.distanceMm};${row.polyline}`;
}

/**
 * The prefilter of `SEG-005`: the segments of the sport's family, trashed ones included so a restore finds their efforts,
 * whose box overlaps the activity's. The `segment_bbox` index narrows on latitude, the longitude is checked here.
 */
export function segmentShapesNear(db: ObnixeDatabase, sport: SportKey, bbox: BoundingBoxE7 | null): readonly SegmentShape[] {
  const family = segmentFamilyOf(sport);
  if (family === null || bbox === null) return [];
  const box = segmentSearchBox(bbox);
  return db
    .select()
    .from(segment)
    .where(and(eq(segment.family, family), lte(segment.south, box.north), gte(segment.north, box.south)))
    .all()
    .filter((row) => boxesOverlap(box, row.bbox))
    .map(segmentShape);
}

/** Segments, trashed ones included, never searched over the whole history or searched with another geometry (`SEG-003`). */
export function staleSegments(db: ObnixeDatabase): readonly Segment[] {
  return db
    .select({ segment, shapeKey: segmentDerivation.shapeKey })
    .from(segment)
    .leftJoin(segmentDerivation, eq(segmentDerivation.segmentId, segment.id))
    .orderBy(asc(segment.createdAt))
    .all()
    .filter((row) => row.shapeKey !== segmentShapeKey(row.segment))
    .map((row) => row.segment);
}

/** Starts a sweep: the efforts found with another geometry go, and sessions saved meanwhile add theirs as usual. */
export function clearSegmentEfforts(db: ObnixeDatabase, segmentIds: readonly Id[]): void {
  if (segmentIds.length === 0) return;
  db.delete(segmentEffort).where(inArray(segmentEffort.segmentId, [...segmentIds])).run();
}

/** Saved recordings, trashed ones included, of a family and box that may pass one of the segments, in start order. */
export function segmentSweepCandidates(db: ObnixeDatabase, shapes: readonly SegmentShape[]): readonly SessionRecording[] {
  if (shapes.length === 0) return [];
  return db
    .select({ session, recording })
    .from(recording)
    .innerJoin(session, eq(session.id, recording.sessionId))
    .where(and(isNotNull(recording.trackFile), isNotNull(recording.bbox), eq(session.status, "completed")))
    .orderBy(asc(session.startedAt))
    .all()
    .filter((row) => {
      const family = segmentFamilyOf(row.session.sport);
      if (family === null || row.recording.bbox === null) return false;
      const box = segmentSearchBox(row.recording.bbox);
      return shapes.some((shape) => shape.family === family && boxesOverlap(box, shape.bbox));
    });
}

/** Ends a sweep: each segment still drawn as it was searched is current. */
export function markSegmentsSwept(db: ObnixeDatabase, swept: readonly Segment[]): void {
  if (swept.length === 0) return;
  db.transaction((tx) => {
    const current = new Map(
      tx
        .select()
        .from(segment)
        .where(
          inArray(
            segment.id,
            swept.map((row) => row.id),
          ),
        )
        .all()
        .map((row) => [row.id, segmentShapeKey(row)]),
    );
    for (const row of swept) {
      const shapeKey = segmentShapeKey(row);
      if (current.get(row.id) !== shapeKey) continue;
      tx.insert(segmentDerivation).values({ segmentId: row.id, shapeKey }).onConflictDoUpdate({ target: segmentDerivation.segmentId, set: { shapeKey } }).run();
    }
  });
}
