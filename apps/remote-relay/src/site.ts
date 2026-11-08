import { plainResponse } from "./responses.ts";

const contactEmail = "james.standbridge.git@gmail.com";
const updatedOn = "8 November 2026";

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
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>${style}</style></head><body><main>${body}</main></body></html>`;
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
  <p>Your offline training log: strength, running, climbing, swimming, cycling, hiking and yoga. Your data stays on your phone.</p>
  <p><a href="/privacy">Privacy policy</a></p>
`;

const privacy = `
  <h1>Privacy policy</h1>
  <p class="muted">Last updated: ${updatedOn}</p>

  <h2>Who we are</h2>
  <p>Obnixe is published by James Standbridge, an independent developer. Contact: <a href="mailto:${contactEmail}">${contactEmail}</a>.</p>

  <h2>The principle: your data stays on your phone</h2>
  <p>Obnixe works without an account and without a storage server. Everything you record is kept in a database on your phone. We do not receive, store or sell any of it. The app contains no advertising, no analytics and no trackers.</p>

  <h2>Data recorded on your phone</h2>
  <ul>
    <li>your sessions and activities, programs and exercises;</li>
    <li>your body measurements: weight, circumferences;</li>
    <li>how you feel: energy, fatigue, reported pain;</li>
    <li>your progress photos, if you add any.</li>
  </ul>
  <p>This data only leaves your phone if you export it yourself or connect an agent, as described below.</p>

  <h2>Permissions</h2>
  <ul>
    <li><strong>Camera</strong>: scan the QR code that pairs the app with your computer, and take progress photos.</li>
    <li><strong>Photos</strong>: import progress photos you pick.</li>
    <li><strong>Notifications</strong>: rest timer and agent authorization requests.</li>
  </ul>

  <h2>AI agents</h2>
  <p>You may choose to let an agent (for example Claude) read and record your training. Nothing is shared until you connect and authorize an agent, and you can turn access off or revoke an agent at any time from the Agent screen.</p>
  <ul>
    <li><strong>With your computer</strong>: the phone talks to the obnixe-bridge program installed on your computer, either directly on your network or through a rendezvous relay hosted by Fly.io. These exchanges are end-to-end encrypted: the relay cannot read them.</li>
    <li><strong>Remote access</strong>: the phone receives the agent's requests through the Obnixe relay, hosted by Cloudflare acting as a processor. Exchanges are encrypted in transit (HTTPS). The relay forwards them without storing or logging their content. Cloudflare may process technical connection data, such as IP addresses, to secure its network.</li>
  </ul>
  <p>Data you choose to send to an agent is then processed by that agent's provider (for example Anthropic for Claude) under its own privacy policy.</p>

  <h2>Retention and deletion</h2>
  <p>Your data stays on your phone as long as the app is installed. You can delete it in the app, or all at once by uninstalling the app. Since we hold no copy, there is nothing to delete on our side.</p>

  <h2>Your rights</h2>
  <p>Under the GDPR, you have the rights of access, rectification, erasure and objection. As your data lives only on your phone, you exercise them directly in the app. For any question, write to <a href="mailto:${contactEmail}">${contactEmail}</a>. You may also lodge a complaint with the CNIL (cnil.fr) or your local data protection authority.</p>

  <h2>Audience</h2>
  <p>Obnixe is intended for adults and is not directed at children.</p>

  <h2>Changes</h2>
  <p>This policy may change as the app evolves. The date at the top of this page shows the latest version.</p>
`;

/** The public pages of obnixe.app, served on its www host. */
export function sitePage(path: string): Response {
  switch (path) {
    case "/":
      return page("Obnixe", home);
    case "/privacy":
      return page("Privacy policy · Obnixe", privacy);
    default:
      return plainResponse(404, "Page not found");
  }
}
