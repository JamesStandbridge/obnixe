export type BatteryVendor = "xiaomi" | "huawei" | "samsung" | "oneplus" | "oppo" | "vivo" | "meizu" | "asus" | "android" | "ios";

export interface BatteryGuide {
  readonly vendor: BatteryVendor;
  readonly brand: string;
  /** Known to stop background services despite the foreground notification (`PLT-011`). */
  readonly aggressive: boolean;
  readonly steps: readonly string[];
}

const vendorsByManufacturer: Readonly<Record<string, BatteryVendor>> = {
  xiaomi: "xiaomi",
  redmi: "xiaomi",
  poco: "xiaomi",
  huawei: "huawei",
  honor: "huawei",
  samsung: "samsung",
  oneplus: "oneplus",
  oppo: "oppo",
  realme: "oppo",
  vivo: "vivo",
  iqoo: "vivo",
  meizu: "meizu",
  asus: "asus",
};

export function batteryVendorOf(manufacturer: string | null, os: "ios" | "android"): BatteryVendor {
  if (os === "ios") return "ios";
  return (manufacturer === null ? undefined : vendorsByManufacturer[manufacturer.trim().toLowerCase()]) ?? "android";
}

const unrestricted = "Réglages › Applications › Obnixe › Batterie › Non restreinte";
const lockInRecents = "Dans les applications récentes, verrouille la carte d'Obnixe pour que le nettoyage la laisse tourner";

/** `PLT-011`: what keeps a recording alive on each family of system, from dontkillmyapp.com. */
export function batteryGuide(vendor: BatteryVendor): BatteryGuide {
  switch (vendor) {
    case "xiaomi":
      return {
        vendor,
        brand: "Xiaomi, Redmi et Poco",
        aggressive: true,
        steps: ["Réglages › Applications › Gérer les applications › Obnixe › Économiseur de batterie › Pas de restrictions", "Même écran : active Démarrage automatique", lockInRecents],
      };
    case "huawei":
      return {
        vendor,
        brand: "Huawei et Honor",
        aggressive: true,
        steps: ["Réglages › Batterie › Lancement d'applications › Obnixe : passe en gestion manuelle et active les trois options", "Réglages › Batterie : laisse le mode Économie d'énergie coupé pendant la sortie", lockInRecents],
      };
    case "samsung":
      return {
        vendor,
        brand: "Samsung",
        aggressive: true,
        steps: [unrestricted, "Réglages › Batterie › Limites d'utilisation en arrière-plan : retire Obnixe des applications en veille et ajoute-la aux applications jamais en veille"],
      };
    case "oneplus":
      return {
        vendor,
        brand: "OnePlus",
        aggressive: true,
        steps: ["Réglages › Batterie › Optimisation de la batterie › Obnixe › Ne pas optimiser", "Réglages › Applications › Obnixe › Utilisation de la batterie : autorise l'activité en arrière-plan", lockInRecents],
      };
    case "oppo":
      return {
        vendor,
        brand: "Oppo et Realme",
        aggressive: true,
        steps: ["Réglages › Applications › Obnixe › Utilisation de la batterie : autorise l'activité en arrière-plan et le démarrage automatique", lockInRecents],
      };
    case "vivo":
      return {
        vendor,
        brand: "Vivo et iQOO",
        aggressive: true,
        steps: ["Réglages › Batterie › Consommation élevée en arrière-plan : autorise Obnixe", "i Manager › Gestionnaire d'applications › Démarrage automatique : active Obnixe", lockInRecents],
      };
    case "meizu":
      return {
        vendor,
        brand: "Meizu",
        aggressive: true,
        steps: ["Réglages › Applications › Obnixe › Batterie : autorise l'exécution en arrière-plan", lockInRecents],
      };
    case "asus":
      return {
        vendor,
        brand: "Asus",
        aggressive: true,
        steps: ["Gestionnaire mobile › Démarrage automatique : autorise Obnixe", "Réglages › Batterie : coupe le nettoyage automatique à la mise en veille"],
      };
    case "android":
      return {
        vendor,
        brand: "Android",
        aggressive: false,
        steps: [unrestricted, "Laisse le mode Économiseur de batterie coupé pendant la sortie"],
      };
    case "ios":
      return {
        vendor,
        brand: "iPhone",
        aggressive: false,
        steps: ["Ne ferme pas Obnixe depuis le sélecteur d'applications pendant la sortie", "Réglages › Obnixe › Position : garde Lorsque l'app est active ou Toujours, avec Position exacte", "Le mode Économie d'énergie peut espacer les points GPS"],
      };
    default: {
      const unreachable: never = vendor;
      return unreachable;
    }
  }
}
