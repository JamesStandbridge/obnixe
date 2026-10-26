import { useLocalSearchParams } from "expo-router";
import { ProgramEditor } from "@/features/programs/editor/ProgramEditor";

export default function ProgramEdit() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ProgramEditor key={id} id={id} />;
}
