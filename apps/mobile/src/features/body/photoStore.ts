import { Directory, File, Paths } from "expo-file-system";
import { launchCameraAsync, launchImageLibraryAsync, requestCameraPermissionsAsync } from "expo-image-picker";
import type { ImagePickerOptions, ImagePickerResult } from "expo-image-picker";
import type { Id } from "@obnixe/schema";
import { PhotoPermissionError } from "@/features/body/photoTypes";
import type { PhotoSource, StoredPhoto } from "@/features/body/photoTypes";

const folder = "photos";
const options: ImagePickerOptions = { mediaTypes: "images", quality: 0.85, exif: false };

async function pick(source: PhotoSource): Promise<ImagePickerResult> {
  if (source === "library") return launchImageLibraryAsync(options);
  const permission = await requestCameraPermissionsAsync();
  if (!permission.granted) throw new PhotoPermissionError(source);
  return launchCameraAsync(options);
}

export async function capturePhoto(source: PhotoSource, id: Id): Promise<StoredPhoto | null> {
  const result = await pick(source);
  const asset = result.canceled ? undefined : result.assets[0];
  if (asset === undefined) return null;
  const directory = new Directory(Paths.document, folder);
  if (!directory.exists) directory.create({ intermediates: true });
  const name = `${id}.jpg`;
  const target = new File(directory, name);
  await new File(asset.uri).copy(target);
  const sha256 = (await target.digest("SHA-256")).toLowerCase();
  return { file: `${folder}/${name}`, sha256, width: asset.width, height: asset.height };
}

export function photoUri(file: string): string {
  return new File(Paths.document, file).uri;
}
