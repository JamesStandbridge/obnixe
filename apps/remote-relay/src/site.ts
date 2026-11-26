import { plainResponse } from "./responses.ts";

const contactEmail = "james.standbridge.git@gmail.com";
const updatedOn = "27 novembre 2026";

const style = `
  body { margin: 0; background: #fbfbf7; color: #17171a; font: 17px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 680px; margin: 0 auto; padding: 40px 22px 64px; }
  h1 { font-size: 30px; line-height: 1.2; margin: 0 0 6px; }
  h2 { font-size: 19px; margin: 34px 0 8px; }
  p, li { margin: 0 0 10px; }
  ul { padding-left: 22px; }
  .muted { color: #5c5c66; font-size: 15px; }
  a { color: inherit; }
`;

function page(title: string, body: string): Response {
  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>${style}</style></head><body><main>${body}</main></body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=3600",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
      "x-content-type-options": "nosniff",
    },
  });
}

const home = `
  <h1>Obnixe</h1>
  <p>Ton carnet d'entraînement hors ligne : musculation, course, trail, escalade, natation, vélo, randonnée et yoga, avec l'enregistrement GPS de tes sorties. Tes données restent sur ton téléphone.</p>
  <p><a href="/privacy">Politique de confidentialité</a></p>
`;

const privacy = `
  <h1>Politique de confidentialité</h1>
  <p class="muted">Dernière mise à jour : ${updatedOn}</p>

  <h2>Qui sommes-nous</h2>
  <p>Obnixe est publiée par James Standbridge, développeur indépendant. Contact : <a href="mailto:${contactEmail}">${contactEmail}</a>.</p>

  <h2>Le principe : tes données restent sur ton téléphone</h2>
  <p>Obnixe fonctionne sans compte et sans serveur de stockage. Tout ce que tu enregistres est gardé dans une base de données sur ton téléphone. Nous n'en recevons, n'en conservons et n'en vendons rien. L'application ne contient ni publicité, ni mesure d'audience, ni traceur.</p>

  <h2>Données enregistrées sur ton téléphone</h2>
  <ul>
    <li>tes séances et activités, programmes et exercices ;</li>
    <li>tes activités enregistrées au GPS : trace de positions, altitude, vitesse, dénivelé, cadence, tours et records ;</li>
    <li>ta fréquence cardiaque pendant une activité, et ton profil physiologique (année de naissance, sexe, fréquence cardiaque maximale), si tu le renseignes ;</li>
    <li>les activités que tu importes depuis une montre ou une autre application (fichiers GPX, TCX ou FIT) ;</li>
    <li>tes zones de confidentialité ;</li>
    <li>tes mesures corporelles : poids, mensurations ;</li>
    <li>ton ressenti : énergie, fatigue, douleurs signalées ;</li>
    <li>tes photos de progression, si tu en ajoutes.</li>
  </ul>
  <p>Ces données ne quittent ton téléphone que dans les cas décrits ci-dessous : cartes, météo, export, sauvegarde et agent.</p>

  <h2>Localisation</h2>
  <p>Obnixe n'utilise ta position que pendant une activité que tu démarres toi-même. L'enregistrement continue écran verrouillé, signalé par une notification permanente, et s'arrête quand tu termines l'activité. Obnixe ne demande jamais l'accès à ta position en permanence et ne la lit jamais en dehors d'un enregistrement.</p>
  <p>Ta trace est enregistrée et traitée sur le téléphone, y compris hors ligne et en mode avion. Pendant un enregistrement, aucune donnée n'est envoyée, à part le chargement des tuiles de la carte affichée.</p>

  <h2>Fréquence cardiaque</h2>
  <p>Si tu connectes une montre ou une ceinture cardiaque, Obnixe lit ta fréquence cardiaque en Bluetooth pendant l'activité. Elle vient aussi des fichiers que tu importes. Elle sert aux zones cardiaques, à l'estimation de l'énergie dépensée et aux graphiques de l'activité. C'est une donnée de santé : elle est enregistrée uniquement sur ton téléphone et nous ne la recevons jamais.</p>

  <h2>Cartes</h2>
  <p>Pour afficher une carte ou télécharger une région hors ligne, l'application charge des tuiles auprès de ces fournisseurs :</p>
  <ul>
    <li><strong>OpenFreeMap</strong> : fond de carte, construit à partir des données OpenStreetMap ;</li>
    <li><strong>Amazon Web Services</strong> (Terrain Tiles, AWS Open Data) : ombrage du relief ;</li>
    <li><strong>IGN</strong> (Géoplateforme) : fond Plan IGN, seulement si tu le choisis.</li>
  </ul>
  <p>Ils reçoivent les coordonnées des tuiles demandées, donc la zone que tu regardes ou télécharges, et ton adresse IP. Ils ne reçoivent jamais ta trace. Les tuiles sont gardées en cache sur le téléphone, dans la limite que tu fixes dans les réglages.</p>

  <h2>Météo</h2>
  <p>Après une activité, Obnixe peut récupérer la météo de ta sortie auprès d'Open-Meteo. La requête contient seulement la position du départ arrondie à 0,1 degré (environ 11 km), la date et les heures de l'activité ; Open-Meteo reçoit aussi ton adresse IP. Ta trace n'est jamais envoyée. Rien n'est demandé pendant l'enregistrement. Tu peux désactiver ces requêtes dans Données et réglages, rubrique Confidentialité, réglage Météo des activités.</p>

  <h2>Zones de confidentialité</h2>
  <p>Tu peux définir des zones (ton domicile, ton travail) et masquer le début et la fin de tes traces. Les points concernés sont retirés de tout ce qui sort de l'écran de détail de l'activité : fichiers exportés, aperçus et réponses de l'agent. Les zones sont appliquées par défaut à chaque export ; inclure la trace complète demande une confirmation. Tes distances, durées et dénivelés ne changent pas.</p>

  <h2>Export, partage et sauvegardes</h2>
  <ul>
    <li><strong>Export d'une activité</strong> : le fichier GPX que tu choisis d'exporter, zones de confidentialité appliquées par défaut, est remis à l'application de ton choix.</li>
    <li><strong>Sauvegarde</strong> : quand tu exportes une sauvegarde, elle contient toutes tes données, traces GPS comprises, et tes photos si tu le demandes. Elle est chiffrée sur le téléphone (XChaCha20-Poly1305, clé dérivée de ta phrase de passe par scrypt) et tu choisis où la ranger. Sans ta phrase de passe, personne ne peut la lire, nous non plus.</li>
  </ul>

  <h2>Autorisations</h2>
  <ul>
    <li><strong>Localisation</strong> (pendant l'utilisation, position exacte) : mesurer distance, allure et dénivelé et tracer la carte d'une activité que tu enregistres. Demandée au premier enregistrement. Sans elle, le chronomètre seul reste disponible.</li>
    <li><strong>Activité physique</strong> sur Android, <strong>Mouvements et forme</strong> sur iPhone : lire le podomètre et le baromètre pendant une activité, pour la cadence et le dénivelé. Facultative.</li>
    <li><strong>Bluetooth</strong> : se connecter à ta montre ou à ta ceinture cardiaque. Demandée seulement quand tu connectes une source cardiaque ; sur Android, elle n'est jamais utilisée pour te localiser. Facultative.</li>
    <li><strong>Notifications</strong> : activité en cours et ses commandes, alertes pendant l'activité, minuteur de repos et demandes d'autorisation d'un agent.</li>
    <li><strong>Appareil photo</strong> : lire le QR code qui appaire l'application avec ton ordinateur, et prendre tes photos de progression.</li>
    <li><strong>Photos</strong> : importer les photos de progression que tu choisis.</li>
    <li><strong>Réseau local</strong> sur iPhone : joindre obnixe-bridge sur ton ordinateur.</li>
  </ul>

  <h2>Agents IA</h2>
  <p>Tu peux choisir de laisser un agent (par exemple Claude) lire et noter ton entraînement. Rien n'est partagé tant que tu n'as pas connecté et autorisé un agent, et tu peux couper l'accès ou révoquer un agent à tout moment depuis l'écran Agent.</p>
  <ul>
    <li><strong>Avec ton ordinateur</strong> : le téléphone échange avec le programme obnixe-bridge installé sur ton ordinateur, directement sur ton réseau ou via un relais de rendez-vous hébergé par Fly.io. Ces échanges sont chiffrés de bout en bout : le relais ne peut pas les lire.</li>
    <li><strong>Accès à distance</strong> : le téléphone reçoit les requêtes de l'agent par le relais Obnixe, hébergé par Cloudflare en qualité de sous-traitant. Les échanges sont chiffrés en transit (HTTPS). Le relais les transmet sans en stocker ni en journaliser le contenu. Cloudflare peut traiter des données techniques de connexion, comme les adresses IP, pour sécuriser son réseau.</li>
    <li><strong>Traces GPS</strong> : un agent ne lit les positions de tes activités que si tu actives l'autorisation Lire les traces, désactivée par défaut et révocable à tout moment. Tes zones de confidentialité sont toujours appliquées. Sans cette autorisation, l'agent ne voit que les résumés (distance, durée, dénivelé, fréquence cardiaque moyenne).</li>
  </ul>
  <p>Les données que tu choisis d'envoyer à un agent sont ensuite traitées par le fournisseur de cet agent (par exemple Anthropic pour Claude) selon sa propre politique de confidentialité.</p>

  <h2>Conservation et suppression</h2>
  <p>Tes données restent sur ton téléphone tant que l'application est installée. Tu peux les supprimer dans l'application, ou toutes d'un coup en la désinstallant. Comme nous n'en détenons aucune copie, il n'y a rien à supprimer de notre côté. Les sauvegardes que tu as exportées restent là où tu les as rangées.</p>

  <h2>Tes droits</h2>
  <p>Le RGPD te donne des droits d'accès, de rectification, d'effacement et d'opposition. Comme tes données vivent uniquement sur ton téléphone, tu les exerces directement dans l'application. Pour toute question, écris à <a href="mailto:${contactEmail}">${contactEmail}</a>. Tu peux aussi adresser une réclamation à la CNIL (cnil.fr) ou à l'autorité de protection des données de ton pays.</p>

  <h2>Public</h2>
  <p>Obnixe s'adresse aux adultes et ne vise pas les enfants.</p>

  <h2>Modifications</h2>
  <p>Cette politique peut évoluer avec l'application. La date en haut de cette page indique la dernière version.</p>
`;

/** The public pages of obnixe.app, served on its www host. */
export function sitePage(path: string): Response {
  switch (path) {
    case "/":
      return page("Obnixe", home);
    case "/privacy":
      return page("Politique de confidentialité · Obnixe", privacy);
    default:
      return plainResponse(404, "Page not found");
  }
}
