import { useLocalSearchParams } from "expo-router";
import { ImportActivityScreen } from "@/features/activityFiles/ImportActivityScreen";

export default function ImportActivity() {
  const { file } = useLocalSearchParams<{ file?: string }>();
  return <ImportActivityScreen key={file ?? "picker"} openedFile={file ?? null} />;
}
