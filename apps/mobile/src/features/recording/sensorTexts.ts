import type { ResolvedProfile, SensorRole } from "@obnixe/core";

export interface SensorTexts {
  /** "Capteur cardiaque": the settings row, the pairing screen and the name of a source that advertises none. */
  readonly title: string;
  /** Settings row detail while none is memorized. */
  readonly none: string;
  /** Pairing screen introduction while none is memorized. */
  readonly intro: string;
  /** What the memorized source does once connected. */
  readonly paired: string;
  /** Preparation screen detail while the source advertises, then while it stays silent. */
  readonly seen: string;
  readonly missing: string;
  /** How to wake the source up, shown on the pairing screen and when it stays silent. */
  readonly help: readonly string[];
  /** Whether the memorized name takes the feminine, as a watch does. */
  readonly feminine: boolean;
}

const sharedSource = "Un même capteur peut donner la cadence et la puissance : associe-le aux deux.";

/** `SPT-007`, `SPT-008`: the words of one source, a footpod on foot and a pedal or crank sensor on the bike. */
export function sensorTextsOf(role: SensorRole, profile: Pick<ResolvedProfile, "cadence">): SensorTexts {
  const onFoot = profile.cadence === "steps";
  switch (role) {
    case "heart_rate":
      return {
        title: "Capteur cardiaque",
        none: "Aucun · montre en diffusion ou ceinture",
        intro: "Montre en diffusion ou ceinture Bluetooth : elle se connecte seule au démarrage de chaque sortie, et se reconnecte si le lien se perd.",
        paired: "Connecté au démarrage de la sortie, la fréquence cardiaque prend la dernière place de l'écran de direct.",
        seen: "Elle se connecte au démarrage de la sortie",
        missing: "Lance la diffusion : elle se connectera au démarrage",
        help: [],
        feminine: true,
      };
    case "cadence":
      return onFoot
        ? {
            title: "Capteur de cadence",
            none: "Aucun · footpod, sinon le téléphone",
            intro: "Footpod Bluetooth : il se connecte seul au démarrage de chaque sortie et compte tes pas à la place du téléphone. La distance et l'allure restent celles du GPS.",
            paired: "Connecté au démarrage de la sortie, il donne la cadence à la place du téléphone.",
            seen: "Il se connecte au démarrage de la sortie",
            missing: "Secoue-le pour le réveiller : il se connectera au démarrage",
            help: ["Un footpod se réveille quand il bouge et se rendort après quelques minutes immobile.", sharedSource],
            feminine: false,
          }
        : {
            title: "Capteur de cadence",
            none: "Aucun · capteur de pédalier",
            intro: "Capteur de cadence Bluetooth sur la manivelle : il se connecte seul au démarrage de chaque sortie, et se reconnecte si le lien se perd. La vitesse reste celle du GPS.",
            paired: "Connecté au démarrage de la sortie, il donne la cadence de pédalage.",
            seen: "Il se connecte au démarrage de la sortie",
            missing: "Fais tourner le pédalier : il se connectera au démarrage",
            help: ["Un capteur de pédalier se réveille dès que la manivelle tourne et se rendort après quelques minutes d'arrêt.", sharedSource],
            feminine: false,
          };
    case "power":
      return onFoot
        ? {
            title: "Capteur de puissance",
            none: "Aucun · footpod de puissance",
            intro: "Footpod de puissance Bluetooth : il se connecte seul au démarrage de chaque sortie, et la puissance s'enregistre avec la trace.",
            paired: "Connecté au démarrage de la sortie, la puissance s'enregistre avec la trace.",
            seen: "Il se connecte au démarrage de la sortie",
            missing: "Secoue-le pour le réveiller : il se connectera au démarrage",
            help: ["Seule la puissance Bluetooth standard est lue : vérifie qu'elle est activée dans l'application du footpod.", sharedSource],
            feminine: false,
          }
        : {
            title: "Capteur de puissance",
            none: "Aucun · pédales, manivelle ou moyeu",
            intro: "Capteur de puissance Bluetooth : il se connecte seul au démarrage de chaque sortie. La puissance s'enregistre avec la trace et donne les calories de la sortie.",
            paired: "Connecté au démarrage de la sortie, la puissance s'enregistre et donne les calories de la sortie.",
            seen: "Il se connecte au démarrage de la sortie",
            missing: "Fais tourner le pédalier : il se connectera au démarrage",
            help: ["Un capteur de puissance se réveille dès que la manivelle tourne. Fais son zéro depuis son application avant de partir.", sharedSource],
            feminine: false,
          };
    default: {
      const unreachable: never = role;
      throw new Error(`Unhandled sensor role ${String(unreachable)}`);
    }
  }
}
