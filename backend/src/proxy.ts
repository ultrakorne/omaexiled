// Port of EE2 main/src/proxy.ts per the normative spec in
// docs/port-notes/05-trade-api-and-price-sources.md §16.
//
// `/proxy/<host>/<raw path+query>` -> `https://<host>/<raw path+query>`,
// path not decoded. Status, rate-limit headers and body pass through
// unchanged; cookies come from the backend jar (official hosts only); the
// User-Agent is the Qt host's Chromium UA, so a Cloudflare clearance
// obtained in the in-app browser stays valid.
import type { CookieJar } from "./cookie-jar";
import type { Logger } from "./logger";

export const PROXY_HOSTS = new Map<string, boolean>([
  ["www.pathofexile.com", true],
  ["ru.pathofexile.com", true],
  ["pathofexile.tw", true],
  ["poe.kakaogames.com", true],
  ["jp.pathofexile.com", true],
  ["de.pathofexile.com", true],
  ["es.pathofexile.com", true],
  ["br.pathofexile.com", true],
  ["fr.pathofexile.com", true],
  ["poe.ninja", false],
  ["www.poeprices.info", false],
  // EE2 author's mirror of poe.ninja data
  ["api.exiledexchange2.dev", false],
]);

// What QtWebEngine 6.11 reports; replaced by the host's `hello.userAgent`.
export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) QtWebEngine/6.11.2 Chrome/140.0.0.0 Safari/537.36";

const DROP_REQ = new Set([
  "host",
  "origin",
  "referer",
  "cookie",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-connection",
  "proxy-authorization",
  "accept-encoding",
  "user-agent",
]);

const DROP_RES = new Set([
  // Bun's fetch already decoded the body but keeps these
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  // consumed by the jar
  "set-cookie",
  // a hostile page must never be able to read proxied responses
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "alt-svc",
]);

export interface ProxyDeps {
  jar: CookieJar;
  logger: Logger;
  userAgent(): string;
  // tests point the proxy at a local stub
  upstream?: (host: string) => string;
}

export async function handleProxy(req: Request, deps: ProxyDeps): Promise<Response> {
  const u = new URL(req.url);
  const rest = u.pathname.slice("/proxy/".length);
  const host = rest.split("/", 1)[0];
  const official = PROXY_HOSTS.get(host);
  if (official === undefined) return new Response(null, { status: 403 });
  const base = deps.upstream ? deps.upstream(host) : `https://${host}`;
  const target = base + rest.slice(host.length) + u.search;
  const cookieUrl = new URL(`https://${rest}`);

  const headers = new Headers();
  req.headers.forEach((v, k) => {
    if (!k.startsWith("sec-") && !DROP_REQ.has(k)) headers.set(k, v);
  });
  headers.set("user-agent", deps.userAgent());
  if (official) {
    const cookie = deps.jar.cookieHeader(cookieUrl);
    if (cookie) headers.set("cookie", cookie);
  }

  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
  let up: Response;
  try {
    up = await fetch(target, {
      method: req.method,
      headers,
      body,
      redirect: "follow",
      signal: AbortSignal.any([req.signal, AbortSignal.timeout(60_000)]),
    });
  } catch (e) {
    const message = (e as Error).message;
    if (!req.signal.aborted) deps.logger.write(`error [proxy] ${message} (${host})`);
    return Response.json(
      { error: { code: -1, message: `OmaExiled proxy: ${message}` } },
      { status: 502 },
    );
  }
  if (official) {
    for (const sc of up.headers.getSetCookie()) deps.jar.setFromHeader(cookieUrl, sc);
  }
  if (up.status === 429 || (up.status === 403 && up.headers.get("cf-mitigated"))) {
    deps.logger.write(
      `warn [proxy] ${up.status}${up.headers.get("cf-mitigated") ? " (Cloudflare challenge)" : ""} ${u.pathname.slice(6, 60)}`,
    );
  }
  const out = new Headers();
  up.headers.forEach((v, k) => {
    if (!DROP_RES.has(k)) out.append(k, v);
  });
  return new Response(up.body, { status: up.status, statusText: up.statusText, headers: out });
}
