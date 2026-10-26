import { request as forward, createServer } from "node:http";

const target = Number(process.env.METRO_PORT ?? 8081);
const port = Number(process.env.PREVIEW_PORT ?? 8095);

createServer((incoming, outgoing) => {
  const upstream = forward(
    { host: "localhost", port: target, path: incoming.url, method: incoming.method, headers: { ...incoming.headers, host: `localhost:${target}` } },
    (response) => {
      outgoing.writeHead(response.statusCode ?? 502, {
        ...response.headers,
        "cross-origin-embedder-policy": "credentialless",
        "cross-origin-opener-policy": "same-origin",
      });
      response.pipe(outgoing);
    },
  );
  upstream.on("error", () => {
    outgoing.writeHead(502);
    outgoing.end();
  });
  incoming.pipe(upstream);
}).listen(port, () => {
  console.log(`Web preview on http://localhost:${port} (Metro on ${target})`);
});
