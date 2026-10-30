import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigStore } from "../src/config-store";
import { Logger } from "../src/logger";
import { Server } from "../src/server";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "omaexiled-server-"));
const dist = path.join(root, "dist");
fs.mkdirSync(path.join(dist, "data/en"), { recursive: true });
fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
fs.writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>t</title>");
fs.writeFileSync(path.join(dist, "assets/app.js"), "console.log(1)");
fs.writeFileSync(path.join(dist, "data/en/items.ndjson"), '{"a":1}\n');
fs.writeFileSync(path.join(root, "secret.txt"), "secret");

const logger = new Logger();
logger.write = ((orig) => (m: string) => {
  // keep history and listeners, skip stderr noise
  const write = process.stderr.write;
  process.stderr.write = () => true;
  try {
    orig.call(logger, m);
  } finally {
    process.stderr.write = write;
  }
})(logger.write);
logger.write("info [Test] first line");

const config = new ConfigStore(path.join(root, "cfg"), logger);
let overlayWanted = 0;
const server = new Server({
  port: 0,
  rendererDir: dist,
  logger,
  config,
  version: "9.9.9",
  proxy: async () => new Response("proxied"),
  onOverlayWanted: () => overlayWanted++,
});

let base = "";
beforeAll(async () => {
  await server.start();
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => {
  server.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

interface Conn {
  ws: WebSocket;
  messages: { name: string; payload?: any }[];
  next(name: string, timeout?: number): Promise<{ name: string; payload?: any }>;
  close(): Promise<void>;
}

function connect(query = "", headers: Record<string, string> = {}): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/events${query}`, { headers } as any);
    const messages: Conn["messages"] = [];
    const consumed = new Set<object>();
    const waiters: { name: string; resolve: (m: any) => void }[] = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      messages.push(m);
      const w = waiters.find((w) => w.name === m.name);
      if (w) {
        waiters.splice(waiters.indexOf(w), 1);
        consumed.add(m);
        w.resolve(m);
      }
    };
    const closed = new Promise<void>((r) => ws.addEventListener("close", () => r()));
    ws.onerror = () => reject(new Error("ws error"));
    ws.onopen = () =>
      resolve({
        ws,
        messages,
        async close() {
          ws.close();
          await closed;
          await tick(20);
        },
        next(name, timeout = 1000) {
          const have = messages.find((m) => m.name === name && !consumed.has(m));
          if (have) {
            consumed.add(have);
            return Promise.resolve(have);
          }
          return new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error(`timeout waiting for ${name}`)), timeout);
            waiters.push({
              name,
              resolve: (m) => {
                clearTimeout(t);
                res(m);
              },
            });
          });
        },
      });
  });
}

const tick = (ms = 30) => Bun.sleep(ms);
const ITEM = { target: "price-check", clipboard: "Item Class: Rings", position: { x: 1, y: 2 }, focusOverlay: false };

describe("WebSocket /events", () => {
  test("new clients get the log history first", async () => {
    const c = await connect("?role=settings");
    const first = await c.next("MAIN->CLIENT::log-entry");
    expect(first.payload.message).toContain("info [Test] first line");
    await c.close();
  });

  test("roles: item-text goes to overlay pages only, the rest is broadcast", async () => {
    const overlay = await connect("?role=overlay");
    const settings = await connect("?role=settings");
    const browser = await connect("");
    await tick();
    expect(server.roles()).toEqual({ overlay: 1, settings: 1, browser: 1 });

    server.sendItemText(ITEM);
    const got = await overlay.next("MAIN->CLIENT::item-text");
    expect(got.payload).toEqual(ITEM);
    server.sendEventTo("broadcast", { name: "MAIN->OVERLAY::hide-exclusive-widget", payload: undefined });
    await settings.next("MAIN->OVERLAY::hide-exclusive-widget");
    await browser.next("MAIN->OVERLAY::hide-exclusive-widget");
    await tick();
    expect(settings.messages.some((m) => m.name === "MAIN->CLIENT::item-text")).toBe(false);
    expect(browser.messages.some((m) => m.name === "MAIN->CLIENT::item-text")).toBe(false);
    // void payloads have no payload key (EE2 framing)
    expect(JSON.stringify(settings.messages.at(-1))).toBe('{"name":"MAIN->OVERLAY::hide-exclusive-widget"}');

    // inbound events carry the sender role
    const seen: string[] = [];
    server.onEventAnyClient("OVERLAY->MAIN::render-state", (p, sender) => seen.push(`${sender.role}:${p.shouldShow}`));
    overlay.ws.send(JSON.stringify({ name: "OVERLAY->MAIN::render-state", payload: { shouldShow: true } }));
    settings.ws.send("not json");
    settings.ws.send(JSON.stringify({ payload: 1 }));
    await tick();
    expect(seen).toEqual(["overlay:true"]);
    for (const c of [overlay, settings, browser]) await c.close();
  });

  test("item-text is queued until an overlay page connects", async () => {
    const before = overlayWanted;
    server.sendItemText({ ...ITEM, clipboard: "queued 1" });
    server.sendItemText({ ...ITEM, clipboard: "queued 2" });
    expect(overlayWanted).toBe(before + 2);
    await tick(100);
    const overlay = await connect("?role=overlay");
    await overlay.next("MAIN->CLIENT::item-text");
    await tick();
    const texts = overlay.messages.filter((m) => m.name === "MAIN->CLIENT::item-text").map((m) => m.payload.clipboard);
    expect(texts).toEqual(["queued 1", "queued 2"]);
    await overlay.close();
  });

  test(
    "queued item-text expires after 5 s",
    async () => {
      server.sendItemText({ ...ITEM, clipboard: "too old" });
      await Bun.sleep(5200);
      const overlay = await connect("?role=overlay");
      await tick(100);
      expect(overlay.messages.some((m) => m.name === "MAIN->CLIENT::item-text")).toBe(false);
      expect(logger.history).toContain("item text dropped");
      await overlay.close();
    },
    { timeout: 8000 },
  );

  test("foreign Origin is rejected", async () => {
    await expect(connect("?role=overlay", { Origin: "http://evil.example" })).rejects.toThrow();
    const ok = await connect("?role=overlay", { Origin: `http://localhost:${server.port}` });
    await ok.close();
  });

  test("shutdown closes with a code Sockette reconnects on", async () => {
    const s = new Server({ port: 0, rendererDir: dist, logger, config, version: "x", proxy: async () => new Response() });
    await s.start();
    const c2 = await new Promise<WebSocket>((res) => {
      const ws = new WebSocket(`ws://127.0.0.1:${s.port}/events?role=overlay`);
      ws.onopen = () => res(ws);
    });
    const code2 = new Promise<number>((r) => (c2.onclose = (e) => r(e.code)));
    s.stop();
    expect(await code2).toBe(1012);
    expect([1000, 1001, 1005]).not.toContain(await code2);
  });
});

describe("HTTP", () => {
  test("GET /config returns HostState", async () => {
    let res = await fetch(`${base}/config`);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({
      version: "9.9.9",
      updater: { state: "update-not-available", checkedAt: expect.any(Number) },
      contents: null,
    });
    await config.save('{"leagueId":"Standard"}', false);
    res = await fetch(`${base}/config`);
    expect(((await res.json()) as any).contents).toBe('{"leagueId":"Standard"}');
  });

  test("static files", async () => {
    let res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    res = await fetch(`${base}/?mode=overlay`);
    expect(await res.text()).toContain("<title>t</title>");
    res = await fetch(`${base}/assets/app.js?v=1`);
    expect(res.headers.get("content-type")).toStartWith("text/javascript");
    expect(res.headers.get("cache-control")).toBeNull();
    res = await fetch(`${base}/data/en/items.ndjson`);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.text()).toBe('{"a":1}\n');
    expect((await fetch(`${base}/missing.js`)).status).toBe(404);
    expect((await fetch(`${base}/data`)).status).toBe(404);
  });

  test("path traversal is rejected", async () => {
    for (const p of ["/..%2fsecret.txt", "/%2e%2e/secret.txt", "/assets/..%2f..%2fsecret.txt"]) {
      const res = await fetch(`${base}${p}`);
      expect([403, 404]).toContain(res.status);
      expect(await res.text()).not.toContain("secret");
    }
  });

  test("Host must be ours", async () => {
    const res = await fetch(`${base}/config`, { headers: { Host: "evil.example:80" } });
    expect(res.status).toBe(403);
    const ok = await fetch(`${base}/config`, { headers: { Host: `localhost:${server.port}` } });
    expect(ok.status).toBe(200);
  });

  test("proxy requests need our Origin and a same-origin fetch", async () => {
    expect((await fetch(`${base}/proxy/poe.ninja/x`)).status).toBe(200);
    expect((await fetch(`${base}/proxy/poe.ninja/x`, { headers: { Origin: "https://evil.example" } })).status).toBe(403);
    expect((await fetch(`${base}/proxy/poe.ninja/x`, { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
    expect(
      (await fetch(`${base}/proxy/poe.ninja/x`, { headers: { Origin: base, "Sec-Fetch-Site": "same-origin" } })).status,
    ).toBe(200);
  });
});
