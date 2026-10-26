export type PhotoSource = "camera" | "library";

export interface StoredPhoto {
  readonly file: string;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
}

export class PhotoPermissionError extends Error {
  constructor(readonly source: PhotoSource) {
    super(`Permission denied for ${source}`);
  }
}
