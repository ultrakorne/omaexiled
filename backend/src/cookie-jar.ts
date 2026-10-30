// Cookie jar for the trade proxy (EE2 used Electron's persistent session
// jar, shared with its built-in browser). Fed by `Set-Cookie` from the
// official hosts and by the Qt host's in-app browser (`cookies` messages:
// cf_clearance, POESESSID after a login). Persisted to cookies.json (0600).
// Values are never logged.
import fs from "node:fs";
import { writeAtomic } from "./config-store";
import type { Logger } from "./logger";

export interface StoredCookie {
  name: string;
  value: string;
  domain: string; // lower case, no leading dot
  hostOnly: boolean;
  path: string;
  expires: number | null; // epoch ms, null = session
  secure: boolean;
  httpOnly: boolean;
  created: number;
  fromHost?: boolean; // last set by the Qt host's browser, not by a response
}

// The shape the Qt host sends (QNetworkCookie): a leading dot on `domain`
// marks a domain cookie; `expires` in epoch seconds or ms, an ISO string,
// or null/0/-1 for session cookies.
export interface HostCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires?: number | string | null;
  secure?: boolean;
  httpOnly?: boolean;
}

function domainMatch(host: string, domain: string) {
  return host === domain || host.endsWith(`.${domain}`);
}

function pathMatch(reqPath: string, cookiePath: string) {
  if (reqPath === cookiePath) return true;
  if (!reqPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || reqPath[cookiePath.length] === "/";
}

function defaultPath(reqPath: string) {
  if (!reqPath.startsWith("/")) return "/";
  const i = reqPath.lastIndexOf("/");
  return i <= 0 ? "/" : reqPath.slice(0, i);
}

// Cloudflare sets `Partitioned` cookies; EE2 strips the attribute so they
// are sent back (main/src/proxy.ts).
export function stripPartitioned(setCookie: string) {
  return setCookie
    .split(";")
    .filter((part) => part.trim().toLowerCase() !== "partitioned")
    .join(";");
}

export class CookieJar {
  private cookies: StoredCookie[] = [];
  private saveTimer?: ReturnType<typeof setTimeout>;
  // Optional logged-in session (secrets.json / OMAEXILED_POESESSID).
  poesessid: string | null = null;

  constructor(
    private file?: string,
    private logger?: Logger,
  ) {
    if (file) this.load();
  }

  private load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file!, "utf8"));
      if (Array.isArray(data.cookies)) this.cookies = data.cookies;
      this.purge();
    } catch {}
  }

  private scheduleSave() {
    if (!this.file) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 500);
  }

  saveNow() {
    if (!this.file) return;
    clearTimeout(this.saveTimer);
    try {
      writeAtomic(this.file, JSON.stringify({ version: 1, cookies: this.cookies }), 0o600);
    } catch (e) {
      this.logger?.write(`error [proxy] Failed to save cookies: ${(e as Error).message}`);
    }
  }

  private purge(now = Date.now()) {
    this.cookies = this.cookies.filter((c) => c.expires == null || c.expires > now);
  }

  private upsert(c: StoredCookie) {
    const i = this.cookies.findIndex(
      (x) => x.name === c.name && x.domain === c.domain && x.path === c.path,
    );
    const expired = c.expires != null && c.expires <= Date.now();
    if (i >= 0) {
      c.created = this.cookies[i].created;
      if (expired) this.cookies.splice(i, 1);
      else this.cookies[i] = c;
    } else if (!expired) {
      this.cookies.push(c);
    }
    this.scheduleSave();
  }

  // RFC 6265 §5.2-5.3, the parts that matter for a few HTTPS hosts.
  setFromHeader(url: URL, header: string) {
    const parts = stripPartitioned(header).split(";");
    const first = parts.shift() ?? "";
    const eq = first.indexOf("=");
    if (eq <= 0) return;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    const host = url.hostname.toLowerCase();
    let domain = "";
    let path = "";
    let expires: number | null = null;
    let maxAge: number | null = null;
    let secure = false;
    let httpOnly = false;
    for (const attr of parts) {
      const i = attr.indexOf("=");
      const key = (i < 0 ? attr : attr.slice(0, i)).trim().toLowerCase();
      const val = i < 0 ? "" : attr.slice(i + 1).trim();
      if (key === "domain") domain = val.replace(/^\./, "").toLowerCase();
      else if (key === "path") path = val;
      else if (key === "expires") {
        const t = Date.parse(val);
        if (!Number.isNaN(t)) expires = t;
      } else if (key === "max-age") {
        const n = Number(val);
        if (Number.isFinite(n)) maxAge = n;
      } else if (key === "secure") secure = true;
      else if (key === "httponly") httpOnly = true;
    }
    if (maxAge != null) expires = Date.now() + maxAge * 1000;
    if (domain && !domainMatch(host, domain)) return;
    this.upsert({
      name,
      value,
      domain: domain || host,
      hostOnly: !domain,
      path: path.startsWith("/") ? path : defaultPath(url.pathname),
      expires,
      secure,
      httpOnly,
      created: Date.now(),
    });
  }

  // The host sends its complete set of pathofexile.com cookies on every
  // change: cookies it sent before and no longer has were removed there.
  replaceFromHost(list: HostCookie[]) {
    const keep = new Set<string>();
    for (const c of list) {
      const stored = this.setFromHost(c);
      if (stored) keep.add(`${stored.name}\x1f${stored.domain}\x1f${stored.path}`);
    }
    const before = this.cookies.length;
    this.cookies = this.cookies.filter(
      (c) => !c.fromHost || keep.has(`${c.name}\x1f${c.domain}\x1f${c.path}`),
    );
    if (this.cookies.length !== before) this.scheduleSave();
  }

  setFromHost(c: HostCookie): StoredCookie | null {
    if (!c || typeof c.name !== "string" || typeof c.domain !== "string") return null;
    let expires: number | null = null;
    if (typeof c.expires === "number" && c.expires > 0) {
      expires = c.expires < 1e11 ? c.expires * 1000 : c.expires;
    } else if (typeof c.expires === "string" && c.expires) {
      const t = Date.parse(c.expires);
      if (!Number.isNaN(t)) expires = t;
    }
    const stored: StoredCookie = {
      name: c.name,
      value: String(c.value ?? ""),
      domain: c.domain.replace(/^\./, "").toLowerCase(),
      hostOnly: !c.domain.startsWith("."),
      path: c.path || "/",
      expires,
      secure: Boolean(c.secure),
      httpOnly: Boolean(c.httpOnly),
      created: Date.now(),
      fromHost: true,
    };
    this.upsert(stored);
    return stored;
  }

  cookieHeader(url: URL): string {
    this.purge();
    const host = url.hostname.toLowerCase();
    const matching = this.cookies
      .filter(
        (c) =>
          (c.hostOnly ? host === c.domain : domainMatch(host, c.domain)) &&
          pathMatch(url.pathname, c.path) &&
          (!c.secure || url.protocol === "https:"),
      )
      .sort((a, b) => b.path.length - a.path.length || a.created - b.created);
    const pairs = matching.map((c) => [c.name, c.value] as const);
    if (this.poesessid && domainMatch(host, "pathofexile.com")) {
      const rest = pairs.filter(([n]) => n !== "POESESSID");
      rest.push(["POESESSID", this.poesessid]);
      return rest.map(([n, v]) => `${n}=${v}`).join("; ");
    }
    return pairs.map(([n, v]) => `${n}=${v}`).join("; ");
  }

  get size() {
    return this.cookies.length;
  }

  names() {
    return this.cookies.map((c) => `${c.name}@${c.domain}`);
  }
}
