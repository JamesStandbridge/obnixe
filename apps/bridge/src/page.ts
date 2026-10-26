import { svgQr } from "./qr.ts";
import type { InviteTicket } from "./phone.ts";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function pagePolicy(nonce: string): string {
  return `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}

const style = `
:root { color-scheme: dark; --bg: #0c1013; --surface: #161a1e; --text: #ebeff2; --text2: #b3b8be; --text3: #888d92; --line: #ffffff14; --mark: #e5ed32; --warn: #f5ae39; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--text); font: 16px/1.45 -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; display: grid; place-items: center; }
main { width: min(440px, 100% - 32px); padding: 40px 0; }
.eyebrow { margin: 0; font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--text3); }
h1 { margin: 6px 0 8px; font-size: 30px; line-height: 1.1; letter-spacing: -.02em; }
.lead { margin: 0; color: var(--text2); }
.code { margin: 24px 0 0; padding: 16px; border-radius: 12px; background: #ffffff; }
.code svg { display: block; width: 100%; height: auto; }
.status { margin: 16px 0 0; display: flex; gap: 8px; align-items: center; min-height: 24px; color: var(--text2); }
.dot { width: 8px; height: 8px; border-radius: 4px; border: 1.5px solid var(--text3); flex: none; }
.status[data-tone="done"] .dot { background: var(--mark); border-color: var(--mark); }
.status[data-tone="done"] { color: var(--text); }
.status[data-tone="stale"] .dot { border-color: var(--warn); }
.done .code { opacity: .15; }
ol { margin: 24px 0 0; padding: 0; list-style: none; border-top: 1px solid var(--line); }
li { padding: 10px 0; border-bottom: 1px solid var(--line); display: flex; gap: 12px; }
li span { width: 16px; color: var(--text3); font-weight: 700; flex: none; }
details { margin-top: 20px; color: var(--text2); font-size: 14px; }
summary { cursor: pointer; color: var(--text); font-weight: 600; }
code { font: 13px ui-monospace, Menlo, monospace; color: var(--text); }
a { color: var(--text); }
`;

const script = `
const status = document.getElementById("status");
const label = document.getElementById("label");
const id = document.body.dataset.invite;
const expiresAt = Number(document.body.dataset.expires);
function show(text, tone) {
  label.textContent = text;
  status.dataset.tone = tone;
  if (tone !== "live") clearInterval(timer);
}
function clock() {
  const seconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
  return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
}
async function poll() {
  const response = await fetch("/invite", { cache: "no-store" });
  if (!response.ok) return;
  const invite = await response.json();
  if (invite.id !== id) return show("Un autre QR code a été créé. Recharge la page.", "stale");
  const state = invite.state;
  if (state.kind === "waiting") return show("Valable " + clock() + ", une seule fois", "live");
  if (state.kind === "paired") {
    document.body.classList.add("done");
    return show(state.device + " est relié à ce Mac. Tu peux fermer cette page.", "done");
  }
  if (state.kind === "expired") return show("QR code expiré. Recharge la page pour en créer un autre.", "stale");
  if (state.kind === "refused") return show("Trop d'essais refusés. Recharge la page pour en créer un autre.", "stale");
  return show("Appairage interrompu : " + state.message, "stale");
}
function tick() {
  poll().catch((error) => {
    if (!(error instanceof TypeError)) throw error;
    show("Le bridge ne répond plus. Relance Cursor ou Codex, puis obnixe-bridge pair.", "stale");
  });
}
const timer = setInterval(tick, 1000);
tick();
`;

/** Pairing page served on the control port: the QR code of the live invitation, refreshed until it is used or expires. */
export function pairPage(ticket: InviteTicket, nonce: string): string {
  const hosts = ticket.hosts.map((host) => `<code>${escapeHtml(host)}</code>`).join(", ");
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Obnixe · Relier un téléphone</title>
<style>${style}</style>
</head>
<body data-invite="${escapeHtml(ticket.id)}" data-expires="${ticket.expiresAt}">
<main>
<p class="eyebrow">obnixe-bridge · ${escapeHtml(ticket.name)}</p>
<h1>Scanne ce code avec ton téléphone</h1>
<p class="lead">Le téléphone se relie à ce Mac sans rien saisir.</p>
<div class="code" role="img" aria-label="QR code d'appairage">${svgQr(ticket.url)}</div>
<p class="status" id="status" data-tone="live" aria-live="polite"><span class="dot"></span><span id="label">Valable 5:00, une seule fois</span></p>
<ol>
<li><span>1</span>Dans Obnixe, ouvre Aujourd'hui puis Connecter un agent</li>
<li><span>2</span>Touche Scanner le QR code du Mac et vise ce code</li>
<li><span>3</span>Garde l'écran Agent ouvert pendant la connexion</li>
</ol>
<details>
<summary>Le téléphone ne trouve pas le Mac ?</summary>
<p>Il doit être sur le même Wi-Fi ou sur Tailscale. Adresses annoncées : ${hosts}.</p>
<p>Sans caméra : sur le téléphone, touche Saisir l'adresse, puis lance <code>obnixe-bridge pair 123456</code> avec le code affiché.</p>
<p><a id="invite" href="${escapeHtml(ticket.url)}">Lien d'appairage</a> (s'ouvre dans Obnixe sur le téléphone)</p>
</details>
</main>
<script nonce="${nonce}">${script}</script>
</body>
</html>
`;
}
