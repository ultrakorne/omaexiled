// Mock backend for testing omaexiled-host without the real backend.
//
//   bun host/test/mock-backend.ts [--port 18584] [--socket <path>]
//                                 [--spawn <omaexiled-host>] [--panel x,y,w,h]
//                                 [--renderer <renderer/dist>]
//                                 [--auto-overlay <output>:<width>x<height>]
//
// - listens on <socket> like the backend's host.sock and records every NDJSON
//   message the host sends;
// - serves test pages at http://127.0.0.1:<port>/?mode=overlay|settings: the
//   overlay page is transparent with one opaque panel at --panel (surface
//   px); pages report what they see (load, visibility, keys, pointer, timer
//   ticks) to POST /page-event;
// - control API for test scripts:
//     POST /ctl/send            body = one host message (JSON), written to the host
//     GET  /ctl/received?type=  messages from the host  [{t, msg}]
//     GET  /ctl/page-events?type=&page=   page reports [{t, page, ...}]
//     GET  /ctl/state           summary (connected, host pid, tick rates)
//     POST /ctl/reset           forget recorded messages and page events
// - with --spawn, starts the host like the backend does and exits when it
//   exits (host stdout/stderr go to this process's stderr);
// - with --renderer, serves the real renderer instead of the test pages, with
//   just enough backend for it to boot: /config (no saved config), a silent
//   /events WebSocket and an unfiltered /proxy (test use only), plus
//     POST /ctl/ws-send?role=overlay   body = {name, payload} to those pages
//     GET  /ctl/ws-received?name=      events the pages sent [{t, role, name, payload}]
//   --auto-overlay plays the backend's part for the overlay: render-state
//   shouldShow -> overlay.show / overlay.hide (whole output), input-region ->
//   overlay.input.

import { mkdirSync, rmSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const args = process.argv.slice(2);
function opt(name: string, fallback?: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
}

const port = Number(opt("port", "18584"));
const socketPath = opt(
  "socket",
  `${process.env.XDG_RUNTIME_DIR ?? "/tmp"}/omaexiled-host-test/host.sock`,
)!;
const spawnHost = opt("spawn");
const rendererDir = opt("renderer");
const autoOverlay = opt("auto-overlay")?.match(/^(.+):(\d+)x(\d+)$/);
const wsClients = new Set<any>();
let wsReceived: any[] = [];
const [px, py, pw, ph] = opt("panel", "200,150,420,300")!.split(",").map(Number);
const base = `http://127.0.0.1:${port}`;

type Recorded = { t: number; msg: any };
let received: Recorded[] = [];
let pageEvents: any[] = [];
const ticks: Record<string, number[]> = {};
const lastTick: Record<string, object> = {};
let hostSocket: any = null;
let hostPid: number | null = null;
let buffer = "";

const log = (...a: any[]) => console.error("[mock]", ...a);

function send(msg: object) {
  if (!hostSocket) return false;
  hostSocket.write(JSON.stringify(msg) + "\n");
  return true;
}

mkdirSync(dirname(socketPath), { recursive: true });
rmSync(socketPath, { force: true });
Bun.listen({
  unix: socketPath,
  socket: {
    open(socket) {
      if (hostSocket) log("second host connection, replacing the first");
      hostSocket = socket;
      buffer = "";
      log("host connected");
    },
    data(_socket, data) {
      buffer += data.toString();
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          log("invalid line from host:", line);
          continue;
        }
        received.push({ t: Date.now(), msg });
        if (msg.type === "cookies") {
          // Never print cookie values.
          log("host -> cookies:", msg.cookies.map((c: any) => `${c.name}@${c.domain}`).join(" "));
        } else {
          log("host ->", JSON.stringify(msg));
        }
      }
    },
    close(socket) {
      if (socket === hostSocket) hostSocket = null;
      log("host disconnected");
    },
  },
});

function overlayPage() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>overlay test</title>
<style>
  html, body { margin: 0; background: transparent; overflow: hidden; }
  #panel { position: absolute; left: ${px}px; top: ${py}px; width: ${pw}px; height: ${ph}px;
           box-sizing: border-box; background: rgb(32, 160, 96); border: 4px solid rgb(250, 220, 40);
           color: white; font: 20px sans-serif; padding: 16px; }
  #panel.hover { background: rgb(40, 90, 200); }
  input { font: inherit; width: 90%; }
</style></head>
<body>
<div id="panel">OmaExiled host test panel<br><span id="info"></span><br><input id="field" placeholder="type here"></div>
<script>${pageScript("overlay")}
  const panel = document.getElementById("panel");
  panel.addEventListener("pointerenter", () => { panel.classList.add("hover"); report({ type: "panel-enter" }); });
  panel.addEventListener("pointerleave", () => { panel.classList.remove("hover"); report({ type: "panel-leave" }); });
  document.getElementById("info").textContent = innerWidth + "x" + innerHeight + " dpr " + devicePixelRatio;
  addEventListener("resize", () => {
    document.getElementById("info").textContent = innerWidth + "x" + innerHeight + " dpr " + devicePixelRatio;
    report({ type: "resize", width: innerWidth, height: innerHeight });
  });
</script></body></html>`;
}

function settingsPage() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>settings test</title>
<style> body { background: #111827; color: #e5e7eb; font: 18px sans-serif; padding: 24px; } </style></head>
<body>
<h1>OmaExiled settings test page</h1>
<p><button id="close" onclick="window.close()">window.close()</button> (or Escape)</p>
<p><a id="external" href="https://example.com/omaexiled-host-test-link">navigate to external link</a></p>
<p><a id="blank" target="_blank" href="https://example.com/omaexiled-host-test-blank">target=_blank link</a></p>
<script>${pageScript("settings")}
  // like the renderer's Save / Cancel / X
  addEventListener("keydown", (e) => { if (e.key === "Escape") window.close(); });
</script></body></html>`;
}

// Shared page reporting: load info, visibility, keys and a 200 ms timer whose
// rate shows whether Chromium throttles the page while it is hidden.
function pageScript(page: string) {
  return `
  const report = (e) => fetch("/page-event", { method: "POST", body: JSON.stringify({ page: "${page}", ...e }) });
  let rafs = 0;
  const raf = () => { rafs++; requestAnimationFrame(raf); };
  requestAnimationFrame(raf);
  report({ type: "loaded", mode: new URLSearchParams(location.search).get("mode"),
           width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
           visibility: document.visibilityState, userAgent: navigator.userAgent });
  console.log("${page} test page loaded");
  document.addEventListener("visibilitychange", () => report({ type: "visibility", visibility: document.visibilityState }));
  addEventListener("keydown", (e) => report({ type: "keydown", key: e.key, code: e.code }));
  addEventListener("focus", () => report({ type: "window-focus" }));
  addEventListener("blur", () => report({ type: "window-blur" }));
  setInterval(() => fetch("/tick?page=${page}&rafs=" + rafs + "&w=" + innerWidth + "&h=" + innerHeight, { method: "POST" }), 200);`;
}

async function serveRenderer(req: Request, url: URL, server: any): Promise<Response | undefined> {
  if (url.pathname === "/events") {
    if (server.upgrade(req, { data: { role: url.searchParams.get("role") } })) return undefined;
    return new Response("upgrade failed", { status: 400 });
  }
  if (url.pathname === "/config") {
    return Response.json({
      contents: null,
      version: "0.0.0-mock",
      updater: { state: "update-not-available", checkedAt: Date.now() },
    });
  }
  if (url.pathname.startsWith("/proxy/")) {
    const target = "https://" + req.url.slice(req.url.indexOf("/proxy/") + "/proxy/".length);
    const headers = new Headers(req.headers);
    for (const h of ["host", "origin", "referer", "cookie", "content-length"]) headers.delete(h);
    const up = await fetch(target, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
    });
    const out = new Headers(up.headers);
    for (const h of ["content-encoding", "content-length", "set-cookie"]) out.delete(h);
    return new Response(up.body, { status: up.status, headers: out });
  }
  const rel = url.pathname === "/" ? "index.html" : normalize(decodeURIComponent(url.pathname)).replace(/^\/+/, "");
  if (rel.startsWith("..")) return new Response("forbidden", { status: 403 });
  const file = Bun.file(join(rendererDir!, rel));
  if (await file.exists()) return new Response(file);
  return undefined;
}

Bun.serve({
  hostname: "127.0.0.1",
  port,
  websocket: {
    open(ws: any) {
      wsClients.add(ws);
      log("renderer connected to /events as", ws.data?.role);
    },
    close(ws: any) {
      wsClients.delete(ws);
    },
    message(ws: any, message: any) {
      log(`renderer (${ws.data?.role}) ->`, String(message).slice(0, 200));
      let e: any;
      try {
        e = JSON.parse(String(message));
      } catch {
        return;
      }
      wsReceived.push({ t: Date.now(), role: ws.data?.role, ...e });
      if (!autoOverlay || ws.data?.role !== "overlay") return;
      if (e.name === "OVERLAY->MAIN::render-state") {
        const [, output, w, h] = autoOverlay;
        send(
          e.payload?.shouldShow
            ? { type: "overlay.show", output, rect: { x: 0, y: 0, width: Number(w), height: Number(h) } }
            : { type: "overlay.hide" },
        );
      } else if (e.name === "OVERLAY->MAIN::input-region") {
        send({ type: "overlay.input", ...e.payload });
      }
    },
  },
  async fetch(req, server) {
    const url = new URL(req.url);
    const q = url.searchParams;
    const json = (v: unknown) => Response.json(v);

    if (rendererDir && !url.pathname.startsWith("/ctl/")) {
      const res = await serveRenderer(req, url, server);
      if (res || url.pathname === "/events") return res;
    }

    if (url.pathname === "/") {
      const mode = q.get("mode");
      const html = mode === "overlay" ? overlayPage() : settingsPage();
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (url.pathname === "/page-event" && req.method === "POST") {
      const e = await req.json();
      pageEvents.push({ t: Date.now(), ...e });
      log("page ->", JSON.stringify(e));
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/tick") {
      const page = q.get("page") ?? "?";
      (ticks[page] ??= []).push(Date.now());
      lastTick[page] = { rafs: Number(q.get("rafs")), width: Number(q.get("w")), height: Number(q.get("h")) };
      if (ticks[page].length > 50) ticks[page].shift();
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/ctl/send" && req.method === "POST") {
      const msg = await req.json();
      log("host <-", JSON.stringify(msg));
      return json({ ok: send(msg) });
    }
    if (url.pathname === "/ctl/received") {
      const type = q.get("type");
      return json(received.filter((r) => !type || r.msg.type === type));
    }
    if (url.pathname === "/ctl/page-events") {
      const type = q.get("type");
      const page = q.get("page");
      return json(pageEvents.filter((e) => (!type || e.type === type) && (!page || e.page === page)));
    }
    if (url.pathname === "/ctl/state") {
      const now = Date.now();
      const rate = (page: string) => {
        const list = (ticks[page] ?? []).filter((t) => now - t < 3000);
        return {
          last3s: list.length,
          lastAgoMs: ticks[page]?.length ? now - ticks[page].at(-1)! : null,
          ...lastTick[page],
        };
      };
      return json({ connected: !!hostSocket, hostPid, ticks: { overlay: rate("overlay"), settings: rate("settings") } });
    }
    if (url.pathname === "/ctl/ws-send" && req.method === "POST") {
      const body = await req.text();
      let n = 0;
      for (const ws of wsClients) {
        if (!q.get("role") || ws.data?.role === q.get("role")) {
          ws.send(body);
          n++;
        }
      }
      return json({ ok: n > 0, clients: n });
    }
    if (url.pathname === "/ctl/ws-received") {
      const name = q.get("name");
      return json(wsReceived.filter((e) => !name || e.name === name));
    }
    if (url.pathname === "/ctl/reset" && req.method === "POST") {
      received = [];
      pageEvents = [];
      wsReceived = [];
      return json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  },
});
log(`http on ${base}, host socket ${socketPath}`);

if (spawnHost) {
  const proc = Bun.spawn([spawnHost, "--socket", socketPath, "--url", base], {
    stdout: "inherit",
    stderr: "inherit",
  });
  hostPid = proc.pid;
  log("spawned host pid", proc.pid);
  proc.exited.then((code) => {
    log("host exited with", code);
    rmSync(socketPath, { force: true });
    process.exit(0);
  });
  const stop = () => {
    proc.kill("SIGTERM");
    setTimeout(() => process.exit(0), 3000);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
