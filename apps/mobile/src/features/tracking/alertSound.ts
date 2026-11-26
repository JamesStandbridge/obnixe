import { createAudioPlayer, setAudioModeAsync, setIsAudioActiveAsync } from "expo-audio";
import type { AudioPlayer } from "expo-audio";
import { File, Paths } from "expo-file-system";
import { beepWave } from "@/features/recording/alerts";

/** The beep lasts 140 ms; the other apps get their volume back shortly after it. */
const duckingMs = 600;

let player: Promise<AudioPlayer> | null = null;
let release: ReturnType<typeof setTimeout> | null = null;

async function createBeep(): Promise<AudioPlayer> {
  const file = new File(Paths.cache, "recording-alert.wav");
  if (!file.exists) await file.write(beepWave());
  await setAudioModeAsync({ interruptionMode: "duckOthers", shouldPlayInBackground: true, playsInSilentMode: false });
  return createAudioPlayer(file.uri);
}

/** `REC-075`: a brief beep over the music, which ducks meanwhile, then gets its focus back. */
export async function playAlertSound(report: (error: unknown) => void): Promise<void> {
  player ??= createBeep().catch((error: unknown) => {
    player = null;
    throw error;
  });
  const beep = await player;
  if (release !== null) clearTimeout(release);
  await setIsAudioActiveAsync(true);
  await beep.seekTo(0);
  beep.play();
  release = setTimeout(() => {
    release = null;
    setIsAudioActiveAsync(false).catch(report);
  }, duckingMs);
}
