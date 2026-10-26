import { photoPoses } from "@obnixe/schema";
import type { EpochMs, Id, LocalDate, Photo, PhotoPose } from "@obnixe/schema";
import type { Mutation } from "../writer.ts";
import { localDateOf } from "../activity/dates.ts";

export interface PhotoDraft {
  readonly id: Id;
  readonly pose: PhotoPose;
  readonly occurredAt: EpochMs;
  readonly timeZone: string;
  readonly file: string;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
}

export interface PoseSlot {
  readonly pose: PhotoPose;
  readonly photo: Photo | null;
}

export interface PhotoOverview {
  readonly latestDate: LocalDate | null;
  readonly slots: readonly PoseSlot[];
}

export function planPhoto(draft: PhotoDraft): Mutation {
  return {
    kind: "insert",
    table: "photo",
    row: {
      id: draft.id,
      pose: draft.pose,
      occurredAt: draft.occurredAt,
      localDate: localDateOf(draft.occurredAt, draft.timeZone),
      timeZone: draft.timeZone,
      file: draft.file,
      sha256: draft.sha256,
      width: draft.width,
      height: draft.height,
      deletedAt: null,
    },
  };
}

function newestFirst(left: Photo, right: Photo): number {
  return right.occurredAt - left.occurredAt;
}

export function photoOverview(photos: readonly Photo[]): PhotoOverview {
  const live = photos.filter((photo) => photo.deletedAt === null).sort(newestFirst);
  const slots = photoPoses.map((pose): PoseSlot => ({ pose, photo: live.find((photo) => photo.pose === pose) ?? null }));
  return { latestDate: live[0]?.localDate ?? null, slots };
}

export function photosOfPose(photos: readonly Photo[], pose: PhotoPose): Photo[] {
  return photos.filter((photo) => photo.deletedAt === null && photo.pose === pose).sort(newestFirst);
}

export function nextPose(photos: readonly Photo[], today: LocalDate): PhotoPose {
  const taken = new Set(photos.filter((photo) => photo.deletedAt === null && photo.localDate === today).map((photo) => photo.pose));
  return photoPoses.find((pose) => !taken.has(pose)) ?? "front";
}
