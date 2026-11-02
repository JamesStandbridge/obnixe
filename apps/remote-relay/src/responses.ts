export function plainResponse(status: number, text: string, headers: Readonly<Record<string, string>> = {}): Response {
  return new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers } });
}
