import { plainResponse } from "./responses.ts";

const contactEmail = "james.standbridge.git@gmail.com";
const updatedOn = "8 novembre 2026";

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
  <p>Ton carnet sportif hors ligne : musculation, course, escalade, natation, vélo, randonnée et yoga. Tes données restent sur ton téléphone.</p>
  <p><a href="/confidentialite">Politique de confidentialité</a></p>
`;

const privacy = `
  <h1>Politique de confidentialité</h1>
  <p class="muted">Dernière mise à jour : ${updatedOn}</p>

  <h2>Qui sommes-nous</h2>
  <p>Obnixe est édité par James Standbridge, développeur indépendant. Contact : <a href="mailto:${contactEmail}">${contactEmail}</a>.</p>

  <h2>Le principe : tes données restent sur ton téléphone</h2>
  <p>Obnixe fonctionne sans compte et sans serveur de stockage. Tout ce que tu enregistres est gardé dans une base de données sur ton téléphone. Nous ne recevons, ne stockons et ne vendons aucune de ces données. L'application ne contient ni publicité, ni outil de mesure d'audience, ni traceur.</p>

  <h2>Données enregistrées sur le téléphone</h2>
  <ul>
    <li>tes séances et activités, tes programmes et tes exercices ;</li>
    <li>tes mesures corporelles : poids, mensurations ;</li>
    <li>tes ressentis : forme, fatigue, douleurs signalées ;</li>
    <li>tes photos de progression, si tu en ajoutes.</li>
  </ul>
  <p>Ces données ne quittent le téléphone que si tu les exportes toi-même ou si tu connectes un agent, comme décrit ci-dessous.</p>

  <h2>Permissions demandées</h2>
  <ul>
    <li><strong>Caméra</strong> : lire le QR code d'appairage avec ton ordinateur et prendre tes photos de progression.</li>
    <li><strong>Photos</strong> : importer des photos de progression que tu choisis.</li>
    <li><strong>Notifications</strong> : minuteur de repos et demandes d'autorisation des agents.</li>
  </ul>

  <h2>Agents d'intelligence artificielle</h2>
  <p>Tu peux, si tu le souhaites, autoriser un agent (par exemple Claude) à lire et à noter ton suivi. Rien n'est partagé tant que tu n'as pas connecté et autorisé un agent, et tu peux couper l'accès ou révoquer un agent à tout moment depuis l'écran Agent.</p>
  <ul>
    <li><strong>Avec ton ordinateur</strong> : le téléphone échange avec le programme obnixe-bridge installé sur ton ordinateur, directement sur ton réseau ou à travers un relais de mise en relation hébergé chez Fly.io. Les échanges sont chiffrés de bout en bout : le relais ne peut pas les lire.</li>
    <li><strong>Accès à distance</strong> : le téléphone reçoit les demandes de l'agent à travers le relais Obnixe, hébergé par Cloudflare, qui agit comme sous-traitant. Les échanges sont chiffrés en transit (HTTPS). Le relais transmet les échanges sans en conserver le contenu ni le journaliser. Cloudflare peut traiter des données techniques de connexion, comme l'adresse IP, pour assurer la sécurité de son réseau.</li>
  </ul>
  <p>Les données que tu choisis d'envoyer à un agent sont ensuite traitées par le fournisseur de cet agent (par exemple Anthropic pour Claude), selon sa propre politique de confidentialité.</p>

  <h2>Conservation et suppression</h2>
  <p>Tes données restent sur le téléphone tant que l'application est installée. Tu peux les supprimer dans l'application, ou toutes à la fois en désinstallant l'application. Comme nous ne détenons aucune copie, il n'y a rien à supprimer de notre côté.</p>

  <h2>Tes droits</h2>
  <p>Conformément au RGPD, tu disposes de droits d'accès, de rectification, d'effacement et d'opposition. Tes données étant uniquement sur ton téléphone, tu les exerces directement dans l'application. Pour toute question, écris à <a href="mailto:${contactEmail}">${contactEmail}</a>. Tu peux aussi adresser une réclamation à la CNIL (cnil.fr).</p>

  <h2>Public</h2>
  <p>Obnixe s'adresse aux adultes et n'est pas destiné aux enfants.</p>

  <h2>Modifications</h2>
  <p>Cette politique peut évoluer avec l'application. La date de mise à jour en haut de page indique la dernière version.</p>
`;

/** The public pages of obnixe.app, served on its www host. */
export function sitePage(path: string): Response {
  switch (path) {
    case "/":
      return page("Obnixe", home);
    case "/confidentialite":
      return page("Politique de confidentialité · Obnixe", privacy);
    default:
      return plainResponse(404, "Page introuvable");
  }
}
