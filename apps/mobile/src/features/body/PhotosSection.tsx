import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import { localDateOf, nextPose, photoOverview, photosOfPose, planPhoto, planTrash } from "@obnixe/core";
import type { Id, Photo, PhotoPose } from "@obnixe/schema";
import { environment } from "@/data/database";
import { useUndoableWrite, write } from "@/data/write";
import { formatDayMonth, formatRelativeDay } from "@/features/activity/format";
import { deviceTimeZone } from "@/format/dates";
import { capturePhoto, photoUri } from "@/features/body/photoStore";
import { PhotoPermissionError } from "@/features/body/photoTypes";
import type { PhotoSource } from "@/features/body/photoTypes";
import { ChoiceButton } from "@/features/activity/components";
import { LinkButton } from "@/ui/Button";
import { Segmented } from "@/ui/Controls";
import { Icon } from "@/ui/icons/Icon";
import { Section } from "@/ui/Layout";
import { Sheet } from "@/ui/Overlays";
import { useSnackbar } from "@/ui/SnackbarHost";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts, radii } from "@/ui/tokens";

interface PhotosSectionProps {
  readonly photos: readonly Photo[];
}

type PhotoSheet = { readonly kind: "none" } | { readonly kind: "take"; readonly pose: PhotoPose } | { readonly kind: "view"; readonly pose: PhotoPose; readonly photoId: Id };

export const poseLabels: Readonly<Record<PhotoPose, string>> = { front: "Face", side: "Profil", back: "Dos" };

export function PhotosSection({ photos }: PhotosSectionProps) {
  const { colors } = useTheme();
  const undoable = useUndoableWrite();
  const notify = useSnackbar();
  const today = localDateOf(environment.now(), deviceTimeZone());
  const [sheet, setSheet] = useState<PhotoSheet>({ kind: "none" });
  const [pose, setPose] = useState<PhotoPose>("front");
  const [busy, setBusy] = useState(false);
  const overview = photoOverview(photos);

  useEffect(() => {
    if (sheet.kind === "take") setPose(sheet.pose);
  }, [sheet]);

  const take = async (source: PhotoSource): Promise<void> => {
    setBusy(true);
    const id = environment.newId();
    try {
      const stored = await capturePhoto(source, id);
      if (stored === null) return;
      write(`Photo : ${poseLabels[pose].toLowerCase()}`, [planPhoto({ id, pose, occurredAt: environment.now(), timeZone: deviceTimeZone(), ...stored })]);
      setSheet({ kind: "none" });
      notify({ text: `Photo enregistrée · ${poseLabels[pose].toLowerCase()}` });
    } catch (error) {
      if (error instanceof PhotoPermissionError) {
        setSheet({ kind: "none" });
        notify({ text: "Accès à l'appareil photo refusé, autorise-le dans les réglages" });
        return;
      }
      throw error;
    } finally {
      setBusy(false);
    }
  };

  const viewed = sheet.kind === "view" ? photosOfPose(photos, sheet.pose) : [];
  const current = sheet.kind === "view" ? viewed.find((photo) => photo.id === sheet.photoId) : undefined;

  return (
    <>
      <Section
        title={overview.latestDate === null ? "Photos" : `Photos · ${formatDayMonth(overview.latestDate)}`}
        action={<LinkButton label="Prendre" onPress={() => setSheet({ kind: "take", pose: nextPose(photos, today) })} style={styles.headLink} />}
      >
        <View style={styles.photos}>
          {overview.slots.map((slot) => (
            <Pressable
              key={slot.pose}
              accessibilityRole="button"
              accessibilityLabel={slot.photo === null ? `${poseLabels[slot.pose]}, prendre une photo` : `${poseLabels[slot.pose]}, ${formatDayMonth(slot.photo.localDate)}`}
              onPress={() => setSheet(slot.photo === null ? { kind: "take", pose: slot.pose } : { kind: "view", pose: slot.pose, photoId: slot.photo.id })}
              style={[styles.photo, { backgroundColor: colors.surface }]}
            >
              {slot.photo === null ? (
                <View style={[styles.silhouette, { backgroundColor: colors.surface2 }]} />
              ) : (
                <Image source={{ uri: photoUri(slot.photo.file) }} style={StyleSheet.absoluteFill} contentFit="cover" transition={120} />
              )}
              <View style={[styles.poseTag, slot.photo !== null && { backgroundColor: colors.bg }]}>
                <Text style={styles.poseLabel} tone={slot.photo === null ? "secondary" : "primary"}>
                  {poseLabels[slot.pose]}
                  {slot.photo !== null && overview.latestDate !== null && slot.photo.localDate !== overview.latestDate ? ` · ${formatDayMonth(slot.photo.localDate)}` : ""}
                </Text>
              </View>
            </Pressable>
          ))}
        </View>
        <View style={styles.privacy}>
          <Icon name="lock" size={18} />
          <Text variant="small" tone="secondary" style={styles.privacyText}>
            Visibles par un agent seulement avec ton accord
          </Text>
        </View>
      </Section>

      <Sheet open={sheet.kind === "take"} title="Photo de progression" context="Même lumière, même distance, pour comparer" onClose={() => setSheet({ kind: "none" })}>
        <Segmented<PhotoPose> options={(Object.keys(poseLabels) as PhotoPose[]).map((value) => ({ value, label: poseLabels[value] }))} value={pose} onChange={setPose} />
        <View style={styles.sources}>
          <ChoiceButton label="Prendre avec l'appareil photo" onPress={() => void take("camera")} />
          <ChoiceButton label="Choisir dans la galerie" onPress={() => void take("library")} />
        </View>
        {busy ? (
          <Text variant="small" tone="secondary" style={styles.busy}>
            Enregistrement…
          </Text>
        ) : null}
      </Sheet>

      <Sheet open={sheet.kind === "view"} title={sheet.kind === "view" ? poseLabels[sheet.pose] : ""} {...(current === undefined ? {} : { context: formatRelativeDay(current.localDate, today) })} onClose={() => setSheet({ kind: "none" })}>
        {current === undefined ? null : (
          <View style={[styles.viewer, { backgroundColor: colors.surface2 }]}>
            <Image source={{ uri: photoUri(current.file) }} style={StyleSheet.absoluteFill} contentFit="contain" accessibilityLabel={`${poseLabels[current.pose]}, ${formatDayMonth(current.localDate)}`} />
          </View>
        )}
        {viewed.length > 1 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.thumbs}>
            {viewed.map((photo) => (
              <Pressable
                key={photo.id}
                accessibilityRole="button"
                accessibilityState={{ selected: photo.id === current?.id }}
                accessibilityLabel={formatDayMonth(photo.localDate)}
                onPress={() => setSheet({ kind: "view", pose: photo.pose, photoId: photo.id })}
                style={styles.thumbCell}
              >
                <View style={[styles.thumb, { backgroundColor: colors.surface }, photo.id === current?.id && { borderColor: colors.text, borderWidth: 2 }]}>
                  <Image source={{ uri: photoUri(photo.file) }} style={StyleSheet.absoluteFill} contentFit="cover" />
                </View>
                <Text variant="caption" tone={photo.id === current?.id ? "primary" : "secondary"} numberOfLines={1}>
                  {formatDayMonth(photo.localDate)}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : null}
        {current === undefined ? null : (
          <View style={styles.remove}>
            <LinkButton
              label="Supprimer la photo"
              onPress={() => {
                setSheet({ kind: "none" });
                undoable({ summary: "Photo supprimée", mutations: [planTrash(environment, "photo", current.id)], message: `Photo supprimée · ${poseLabels[current.pose].toLowerCase()}` });
              }}
            />
          </View>
        )}
      </Sheet>
    </>
  );
}

const styles = StyleSheet.create({
  headLink: { marginVertical: -12, marginRight: -10 },
  photos: { flexDirection: "row", gap: 6, marginTop: 10 },
  photo: { flex: 1, aspectRatio: 3 / 4, borderRadius: radii.control, overflow: "hidden", justifyContent: "flex-end" },
  silhouette: { position: "absolute", left: "33%", top: "18%", width: "34%", height: "64%", borderTopLeftRadius: 40, borderTopRightRadius: 40, borderBottomLeftRadius: 10, borderBottomRightRadius: 10 },
  poseTag: { margin: 6, paddingHorizontal: 4, paddingVertical: 2, borderRadius: radii.tag, alignSelf: "flex-start" },
  poseLabel: { fontFamily: fonts.text600, fontSize: 12, lineHeight: 14 },
  privacy: { flexDirection: "row", gap: 10, alignItems: "flex-start", marginTop: 10 },
  privacyText: { flex: 1, lineHeight: 20 },
  sources: { gap: 8, marginTop: 16 },
  busy: { marginTop: 10, textAlign: "center" },
  viewer: { width: "76%", alignSelf: "center", aspectRatio: 3 / 4, borderRadius: radii.panel, overflow: "hidden", marginTop: 4 },
  thumbs: { gap: 6, marginTop: 10 },
  thumbCell: { width: 72, gap: 4 },
  thumb: { width: 72, aspectRatio: 3 / 4, borderRadius: radii.control, overflow: "hidden" },
  remove: { alignItems: "center", marginTop: 8 },
});
