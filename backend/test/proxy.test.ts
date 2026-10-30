import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CookieJar } from "../src/cookie-jar";
import { Logger } from "../src/logger";
import { handleProxy } from "../src/proxy";

const logger = new Logger();
const logged: string[] = [];
logger.write = (m: string) => {
  logged.push(m);
};

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
}
let last: Seen;
const ITEMS = JSON.stringify({ result: [{ id: "Standard", text: "Standard" }], pad: "x".repeat(4000) });

const upstream = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    last = {
      method: req.method,
      url: url.pathname + url.search,
      headers: Object.fromEntries(req.headers),
      body: new Uint8Array(await req.arrayBuffer()),
    };
    if (url.pathname === "/gzip") {
      return new Response(Bun.gzipSync(new TextEncoder().encode(ITEMS)), {
        headers: {
          "content-type": "application/json",
          "content-encoding": "gzip",
          "x-rate-limit-policy": "trade-search-request-limit",
          "x-rate-limit-rules": "Ip",
          "x-rate-limit-ip": "5:10:60,15:60:300",
          "x-rate-limit-ip-state": "1:10:0,1:60:0",
          "access-control-allow-origin": "*",
          "set-cookie": "POESESSID=fromserver; path=/; domain=.pathofexile.com; secure; HttpOnly; SameSite=Lax",
        },
      });
    }
    if (url.pathname === "/429") {
      return new Response('{"error":{"code":3,"message":"Rate limit exceeded"}}', {
        status: 429,
        headers: { "retry-after": "60", "content-type": "application/json", "x-rate-limit-ip-state": "16:10:60" },
      });
    }
    if (url.pathname === "/cf") {
      const h = new Headers({ "content-type": "text/plain" });
      h.append("set-cookie", "cf_clearance=abc; path=/; domain=.pathofexile.com; Secure; Partitioned");
      return new Response("ok", { headers: h });
    }
    return Response.json({ ok: true }, { headers: { "x-custom": "1", etag: '"e1"' } });
  },
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), "omaexiled-proxy-"));
const jar = new CookieJar(path.join(root, "cookies.json"), logger);
let ua = "Mozilla/5.0 Test QtWebEngine/6.11.2 Chrome/140";
const deps = {
  jar,
  logger,
  userAgent: () => ua,
  upstream: () => `http://127.0.0.1:${upstream.port}`,
};
const proxy = (p: string, init?: RequestInit) => handleProxy(new Request(`http://127.0.0.1:8584/proxy/${p}`, init), deps);

afterAll(() => {
  upstream.stop(true);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("request", () => {
  test("path and query reach upstream byte-exact", async () => {
    await proxy("www.pathofexile.com/api/trade2/search/Runes%20of%20Aldur?x=%2F&y=a+b");
    expect(last.url).toBe("/api/trade2/search/Runes%20of%20Aldur?x=%2F&y=a+b");
  });

  test("headers: drop sec-*, origin, referer, cookie, hop-by-hop; set our UA", async () => {
    await proxy("www.pathofexile.com/api/trade2/data/leagues", {
      headers: {
        accept: "application/json",
        "accept-language": "de",
        "accept-encoding": "identity",
        "sec-fetch-site": "same-origin",
        "sec-ch-ua": '"Chromium"',
        origin: "http://127.0.0.1:8584",
        referer: "http://127.0.0.1:8584/index.html",
        cookie: "local=1",
        "user-agent": "renderer",
        "proxy-authorization": "x",
      },
    });
    const h = last.headers;
    expect(h.accept).toBe("application/json");
    expect(h["accept-language"]).toBe("de");
    expect(h["user-agent"]).toBe(ua);
    for (const k of ["sec-fetch-site", "sec-ch-ua", "origin", "referer", "proxy-authorization"]) {
      expect(h[k]).toBeUndefined();
    }
    expect(h.cookie ?? "").not.toContain("local=1");
    expect(h.host).toBe(`127.0.0.1:${upstream.port}`);
  });

  test("POST JSON and multipart bodies pass through", async () => {
    const json = JSON.stringify({ query: { status: { option: "online" } } });
    await proxy("www.pathofexile.com/api/trade2/search/Standard", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: json,
    });
    expect(last.method).toBe("POST");
    expect(new TextDecoder().decode(last.body)).toBe(json);
    expect(last.headers["content-type"]).toBe("application/json");

    const form = new FormData();
    form.append("i", "Item Class: Rings");
    form.append("selector", "low");
    const req = new Request("http://x/", { method: "POST", body: form });
    const ct = req.headers.get("content-type")!;
    const bytes = new Uint8Array(await req.arrayBuffer());
    await proxy("www.poeprices.info/send_feedback", { method: "POST", headers: { "content-type": ct }, body: bytes });
    expect(last.headers["content-type"]).toBe(ct);
    expect(last.body).toEqual(bytes);
  });

  test("unknown host -> 403 without contacting upstream", async () => {
    last = undefined as any;
    const res = await proxy("evil.example/steal");
    expect(res.status).toBe(403);
    expect(last).toBeUndefined();
  });

  test("UA follows the host's hello", async () => {
    ua = "Mozilla/5.0 Other";
    await proxy("poe.ninja/x");
    expect(last.headers["user-agent"]).toBe("Mozilla/5.0 Other");
  });
});

describe("response", () => {
  test("gzip body decoded byte-exact; encoding/length/set-cookie/ACAO stripped; rate-limit headers kept", async () => {
    const res = await proxy("www.pathofexile.com/gzip");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(ITEMS);
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("content-length")).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("x-rate-limit-policy")).toBe("trade-search-request-limit");
    expect(res.headers.get("x-rate-limit-rules")).toBe("Ip");
    expect(res.headers.get("x-rate-limit-ip")).toBe("5:10:60,15:60:300");
    expect(res.headers.get("x-rate-limit-ip-state")).toBe("1:10:0,1:60:0");
  });

  test("error statuses and bodies pass through unchanged", async () => {
    const res = await proxy("www.pathofexile.com/429");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(res.headers.get("x-rate-limit-ip-state")).toBe("16:10:60");
    expect(await res.json()).toEqual({ error: { code: 3, message: "Rate limit exceeded" } });
  });

  test("other headers are kept", async () => {
    const res = await proxy("poe.ninja/x");
    expect(res.headers.get("x-custom")).toBe("1");
    expect(res.headers.get("etag")).toBe('"e1"');
  });

  test("network error -> 502 JSON", async () => {
    const res = await handleProxy(new Request("http://127.0.0.1:8584/proxy/poe.ninja/x"), {
      ...deps,
      upstream: () => "http://127.0.0.1:1",
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe(-1);
    expect(body.error.message).toStartWith("OmaExiled proxy: ");
    expect(logged.at(-1)).toMatch(/^error \[proxy\] .* \(poe\.ninja\)$/);
  });
});

describe("cookies", () => {
  test("Set-Cookie from official hosts goes to the jar and back, Partitioned stripped", async () => {
    await proxy("www.pathofexile.com/gzip");
    await proxy("www.pathofexile.com/cf");
    await proxy("de.pathofexile.com/api/trade2/data/leagues");
    expect(last.headers.cookie).toBe("POESESSID=fromserver; cf_clearance=abc");
    // never to non-official hosts
    await proxy("poe.ninja/x");
    expect(last.headers.cookie).toBeUndefined();
    // nor to other realms
    await proxy("pathofexile.tw/api");
    expect(last.headers.cookie).toBeUndefined();
  });

  test("POESESSID setting overrides the jar", async () => {
    jar.poesessid = "configured";
    await proxy("www.pathofexile.com/x");
    expect(last.headers.cookie).toBe("cf_clearance=abc; POESESSID=configured");
    jar.poesessid = null;
  });

  test("cookies from the Qt host", async () => {
    jar.setFromHost({ name: "__cf_bm", value: "bm", domain: ".pathofexile.com", path: "/", expires: Date.now() / 1000 + 600, secure: true, httpOnly: true });
    jar.setFromHost({ name: "hostonly", value: "1", domain: "www.pathofexile.com", path: "/api" });
    await proxy("www.pathofexile.com/api/x");
    expect(last.headers.cookie).toContain("__cf_bm=bm");
    expect(last.headers.cookie).toContain("hostonly=1");
    await proxy("de.pathofexile.com/api/x");
    expect(last.headers.cookie).not.toContain("hostonly");
    // expiry in the past deletes
    jar.setFromHost({ name: "__cf_bm", value: "", domain: ".pathofexile.com", path: "/", expires: 1 });
    await proxy("www.pathofexile.com/api/x");
    expect(last.headers.cookie).not.toContain("__cf_bm");
  });

  test("host snapshots replace the cookies the host sent before", async () => {
    const snap = (names: string[]) =>
      names.map((name) => ({ name, value: "v", domain: ".pathofexile.com", path: "/", expires: null, secure: true, httpOnly: true }));
    jar.replaceFromHost(snap(["a", "b"]));
    await proxy("www.pathofexile.com/x");
    expect(last.headers.cookie).toContain("a=v");
    expect(last.headers.cookie).toContain("b=v");
    jar.replaceFromHost(snap(["a"])); // b was removed in the browser
    await proxy("www.pathofexile.com/x");
    expect(last.headers.cookie).toContain("a=v");
    expect(last.headers.cookie).not.toContain("b=v");
    // cookies from responses are not the host's to remove
    expect(last.headers.cookie).toContain("cf_clearance=abc");
    jar.replaceFromHost([]);
    await proxy("www.pathofexile.com/x");
    expect(last.headers.cookie).not.toContain("a=v");
  });

  test("persisted with mode 0600", () => {
    jar.saveNow();
    const file = path.join(root, "cookies.json");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const again = new CookieJar(file);
    expect(again.cookieHeader(new URL("https://www.pathofexile.com/"))).toContain("cf_clearance=abc");
  });
});
