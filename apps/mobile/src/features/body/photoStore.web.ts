import { launchCameraAsync, launchImageLibraryAsync } from "expo-image-picker";
import type { ImagePickerOptions } from "expo-image-picker";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Id } from "@obnixe/schema";
import type { PhotoSource, StoredPhoto } from "@/features/body/photoTypes";

const options: ImagePickerOptions = { mediaTypes: "images", quality: 0.85, base64: true };

function decode(base64: string): Uint8Array {
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function capturePhoto(source: PhotoSource, _id: Id): Promise<StoredPhoto | null> {
  const result = source === "camera" ? await launchCameraAsync(options) : await launchImageLibraryAsync(options);
  const asset = result.canceled ? undefined : result.assets[0];
  if (asset === undefined || asset.base64 === undefined || asset.base64 === null) return null;
  const mime = asset.mimeType ?? "image/jpeg";
  return { file: `data:${mime};base64,${asset.base64}`, sha256: bytesToHex(sha256(decode(asset.base64))), width: asset.width, height: asset.height };
}

export function photoUri(file: string): string {
  return file;
}
