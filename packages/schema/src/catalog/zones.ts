export const zones = {
  neck: { label: "Nuque" },
  upper_back: { label: "Haut du dos" },
  lower_back: { label: "Bas du dos" },
  shoulder_left: { label: "Épaule gauche" },
  shoulder_right: { label: "Épaule droite" },
  elbow_left: { label: "Coude gauche" },
  elbow_right: { label: "Coude droit" },
  wrist_left: { label: "Poignet gauche" },
  wrist_right: { label: "Poignet droit" },
  fingers_left: { label: "Doigts, main gauche" },
  fingers_right: { label: "Doigts, main droite" },
  hip_left: { label: "Hanche gauche" },
  hip_right: { label: "Hanche droite" },
  knee_left: { label: "Genou gauche" },
  knee_right: { label: "Genou droit" },
  ankle_left: { label: "Cheville gauche" },
  ankle_right: { label: "Cheville droite" },
  achilles_left: { label: "Tendon d'Achille gauche" },
  achilles_right: { label: "Tendon d'Achille droit" },
} as const satisfies Record<string, { readonly label: string; readonly retired?: true }>;

export type ZoneKey = keyof typeof zones;
export const zoneKeys = Object.keys(zones) as [ZoneKey, ...ZoneKey[]];
