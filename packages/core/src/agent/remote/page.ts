function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** A JSON literal safe inside an inline script: no "<" can close the element. */
function scriptValue(text: string): string {
  return JSON.stringify(text).replace(/</g, "\\u003c");
}

const style =
  "body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0c1013;color:#f2f3ee;font:17px/1.5 system-ui,-apple-system,sans-serif}" +
  "main{max-width:420px;padding:32px 24px}h1{font-size:28px;line-height:1.15;margin:0 0 16px}p{margin:0 0 12px;color:#b8bcb3}" +
  ".mark{display:inline-block;background:#e5ed32;color:#0c1013;font-weight:700;padding:2px 10px;border-radius:6px;margin-bottom:24px}" +
  ".state{margin-top:24px;color:#e5ed32;font-weight:600}";

function page(title: string, body: string, script: string): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title><style>${style}</style></head><body><main><span class="mark">Obnixe</span>${body}</main>${script}</body></html>`;
}

/** Waiting page shown while the user decides on the phone; it polls the decision and follows the redirect it returns. */
export function authorizationPage(requestId: string, client: string, host: string): string {
  const statusUrl = scriptValue(`/authorize/status?request=${encodeURIComponent(requestId)}`);
  const name = scriptValue(client);
  const script = `<script>(function(){var s=document.getElementById("state");function poll(){fetch(${statusUrl},{cache:"no-store"}).then(function(r){return r.json()}).then(function(d){if(d.status==="done"){s.textContent="C'est fait, retour vers "+${name}+"…";location.replace(d.location);return}if(d.status==="expired"){s.textContent="Demande expirée. Relance la connexion depuis "+${name}+".";return}setTimeout(poll,1500)}).catch(function(){setTimeout(poll,3000)})}poll()})();</script>`;
  return page(
    "Autoriser l'accès à Obnixe",
    `<h1>${escapeHtml(client)} demande l'accès à ton suivi</h1><p>Ouvre l'application Obnixe sur ton téléphone et valide la demande.</p><p>Le retour se fera vers <strong>${escapeHtml(host)}</strong>.</p><p id="state" class="state">En attente de ta réponse sur le téléphone…</p>`,
    script,
  );
}

export function errorPage(message: string): string {
  return page("Obnixe", `<h1>Impossible de continuer</h1><p>${escapeHtml(message)}</p>`, "");
}

export function landingPage(): string {
  return page("Obnixe", "<h1>Ce téléphone sert Obnixe</h1><p>Ajoute cette adresse suivie de /mcp comme connecteur dans ton agent.</p>", "");
}
