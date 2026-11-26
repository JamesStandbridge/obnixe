import type { RefObject } from "react";
import { findNodeHandle, PixelRatio, Platform } from "react-native";
import type { HostInstance } from "react-native";
import { Directory, File, Paths } from "expo-file-system";
import { shareAsync } from "expo-sharing";
import { captureRef } from "react-native-view-shot";

export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

/** Captures the drawn card at `size` pixels and opens the share sheet (`SUM-006`). */
export async function shareCardImage(card: RefObject<HostInstance | null>, size: ImageSize, name: string): Promise<void> {
  const node = findNodeHandle(card.current);
  if (node === null || node === undefined) throw new Error("The share card is not mounted");
  const scale = Platform.OS === "ios" ? PixelRatio.get() : 1;
  const uri = await captureRef(node, { format: "png", result: "tmpfile", width: size.width / scale, height: size.height / scale });
  const directory = new Directory(Paths.cache, "exports");
  directory.create({ idempotent: true, intermediates: true });
  const file = new File(directory, name);
  if (file.exists) file.delete();
  new File(uri).move(file);
  await shareAsync(file.uri, { mimeType: "image/png", UTI: "public.png", dialogTitle: name });
}
