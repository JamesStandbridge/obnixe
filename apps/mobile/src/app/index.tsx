import { sportKeys, sports } from "@obnixe/schema";
import { AppBar, Row, Screen, Section } from "@/ui/Layout";

export default function Today() {
  return (
    <Screen>
      <AppBar title="Aujourd'hui" />
      <Section title="Sports">
        {sportKeys.map((key, index) => (
          <Row key={key} title={sports[key].label} last={index === sportKeys.length - 1} />
        ))}
      </Section>
    </Screen>
  );
}
