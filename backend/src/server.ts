// Port of EE2 main/src/server.ts on Bun.serve: static renderer files,
// /config, /proxy, and the `/events` WebSocket with EE2's protocol
// (`{name, payload}` JSON text frames). Changes (DESIGN.md "Contracts"):
// pages connect with `?role=overlay|settings|browser`; `item-text` goes to
// overlay pages only, queued until one connects; Host/Origin checks.
import path from "node:path";
import type { Server as BunServer, ServerWebSocket } from "bun";
import type { HostState, IpcEvent, IpcEventPayload, UpdateInfo } from "../../ipc/types";
import type { ConfigStore } from "./config-store";
import type { Logger } from "./logger";

export type Role = "overlay" | "settings" | "browser";
interface ClientData {
  role: Role;
}
type Client = ServerWebSocket<ClientData>;

type ItemText = IpcEventPayload<"MAIN->CLIENT::item-text">;
type Listener = (payload: any, sender: { role: Role }) => void;

const ITEM_TEXT_TIMEOUT = 5000;
// Vite's dev server (port 5173) proxies /config, /proxy and /events here
// without changing Host/Origin.
const DEV_HOSTS = ["localhost:5173", "127.0.0.1:5173"];

// Close code for our own shutdown: Sockette reconnects on anything but
// 1000, 1001 and 1005.
const CLOSE_RESTART = 1012;

export interface ServerOptions {
  port: number;
  rendererDir: string;
  logger: Logger;
  config: ConfigStore;
  version: string;
  proxy(req: Request): Promise<Response>;
  // An item-text is waiting and no overlay page is connected.
  onOverlayWanted?(): void;
}

export class Server {
  private server?: BunServer<ClientData>;
  private clients = new Set<Client>();
  private listeners = new Map<string, Set<Listener>>();
  private connectListeners = new Set<(role: Role, send: (e: IpcEvent) => void) => void>();
  private pendingItemText: { payload: ItemText; at: number }[] = [];
  private pendingTimer?: ReturnType<typeof setTimeout>;
  readonly updater: UpdateInfo = { state: "update-not-available", checkedAt: Date.now() };
  private allowedHosts = new Set<string>();
  private allowedOrigins = new Set<string>();

  constructor(private opts: ServerOptions) {
    opts.logger.onWrite((message) => {
      this.sendEventTo("broadcast", { name: "MAIN->CLIENT::log-entry", payload: { message } });
    });
  }

  get port() {
    return this.server?.port ?? this.opts.port;
  }

  get url() {
    return `http://127.0.0.1:${this.port}`;
  }

  roles() {
    const out: Record<Role, number> = { overlay: 0, settings: 0, browser: 0 };
    for (const c of this.clients) out[c.data.role]++;
    return out;
  }

  get hasOverlay() {
    for (const c of this.clients) if (c.data.role === "overlay") return true;
    return false;
  }

  onEventAnyClient<Name extends IpcEvent["name"]>(
    name: Name,
    cb: (payload: IpcEventPayload<Name>, sender: { role: Role }) => void,
  ) {
    let set = this.listeners.get(name);
    if (!set) this.listeners.set(name, (set = new Set()));
    set.add(cb as Listener);
  }

  onClientConnected(cb: (role: Role, send: (e: IpcEvent) => void) => void) {
    this.connectListeners.add(cb);
  }

  emit(name: string, payload: unknown, sender: { role: Role }) {
    for (const cb of this.listeners.get(name) ?? []) {
      try {
        cb(payload, sender);
      } catch (e) {
        this.opts.logger.write(`error [Server] ${name}: ${(e as Error).stack}`);
      }
    }
  }

  sendEventTo(target: "broadcast" | Role, event: IpcEvent) {
    const msg = JSON.stringify(event);
    for (const client of this.clients) {
      if (target === "broadcast" || client.data.role === target) client.send(msg);
    }
  }

  // `item-text` goes to overlay pages only. Without one, the host is
  // started and the event waits for the overlay page (5 s).
  sendItemText(payload: ItemText) {
    if (this.hasOverlay) {
      this.sendEventTo("overlay", { name: "MAIN->CLIENT::item-text", payload });
      return;
    }
    this.pendingItemText.push({ payload, at: Date.now() });
    this.opts.onOverlayWanted?.();
    clearTimeout(this.pendingTimer);
    this.pendingTimer = setTimeout(() => this.expireItemText(), ITEM_TEXT_TIMEOUT + 50);
  }

  private expireItemText() {
    const now = Date.now();
    const before = this.pendingItemText.length;
    this.pendingItemText = this.pendingItemText.filter((e) => now - e.at < ITEM_TEXT_TIMEOUT);
    if (this.pendingItemText.length < before) {
      this.opts.logger.write("warn [Server] No overlay page connected, item text dropped");
    }
  }

  private flushItemText() {
    this.expireItemText();
    const pending = this.pendingItemText;
    this.pendingItemText = [];
    clearTimeout(this.pendingTimer);
    for (const e of pending) {
      this.sendEventTo("overlay", { name: "MAIN->CLIENT::item-text", payload: e.payload });
    }
  }

  // DNS rebinding and cross-site requests: only our own origin may talk to
  // the backend (the proxy attaches the user's trade-site cookies).
  private checkLocal(req: Request, strictOrigin: boolean): boolean {
    const host = req.headers.get("host");
    if (!host || !this.allowedHosts.has(host.toLowerCase())) return false;
    if (strictOrigin) {
      const origin = req.headers.get("origin");
      if (origin != null && !this.allowedOrigins.has(origin.toLowerCase())) return false;
      const site = req.headers.get("sec-fetch-site");
      if (site != null && site !== "same-origin" && site !== "none") return false;
    }
    return true;
  }

  async fetch(req: Request, server: BunServer<ClientData>): Promise<Response | undefined> {
    const url = new URL(req.url);
    if (url.pathname === "/events") {
      if (!this.checkLocal(req, true)) return new Response("Forbidden", { status: 403 });
      const param = url.searchParams.get("role");
      const role: Role = param === "overlay" || param === "settings" ? param : "browser";
      if (server.upgrade(req, { data: { role } })) return undefined;
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    if (url.pathname.startsWith("/proxy/")) {
      if (!this.checkLocal(req, true)) return new Response(null, { status: 403 });
      // Bun closes a request idle for 10 s; the trade API can be slower
      // (league start). The proxy's own 60 s timeout applies instead.
      server.timeout(req, 0);
      return this.opts.proxy(req);
    }
    if (!this.checkLocal(req, false)) return new Response("Forbidden", { status: 403 });
    if (url.pathname === "/config") {
      const body: HostState = {
        version: this.opts.version,
        updater: this.updater,
        contents: await this.opts.config.load(),
      };
      return Response.json(body);
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    return this.serveStatic(url.pathname);
  }

  private async serveStatic(pathname: string): Promise<Response> {
    let rel: string;
    try {
      rel = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
    } catch {
      return new Response("Bad Request", { status: 400 });
    }
    const root = path.resolve(this.opts.rendererDir);
    const file = path.resolve(root, `.${rel}`);
    if (rel.includes("\0") || (file !== root && !file.startsWith(root + path.sep))) {
      return new Response("Forbidden", { status: 403 });
    }
    const f = Bun.file(file);
    if (!(await f.exists())) return new Response("Not Found", { status: 404 });
    const headers: Record<string, string> = {};
    const ext = path.extname(file);
    if (ext === ".js" || ext === ".mjs") headers["content-type"] = "text/javascript; charset=utf-8";
    if (rel.startsWith("/data/")) headers["cache-control"] = "no-cache";
    return new Response(f, { headers });
  }

  async start() {
    this.server = Bun.serve<ClientData>({
      hostname: "127.0.0.1",
      port: this.opts.port,
      fetch: (req, server) => this.fetch(req, server),
      error: (e) => {
        this.opts.logger.write(`error [Server] ${e.message}`);
        return new Response("Internal Server Error", { status: 500 });
      },
      websocket: {
        idleTimeout: 0,
        open: (ws) => {
          this.clients.add(ws);
          ws.send(
            JSON.stringify({
              name: "MAIN->CLIENT::log-entry",
              payload: { message: this.opts.logger.history },
            } satisfies IpcEvent),
          );
          const send = (e: IpcEvent) => ws.send(JSON.stringify(e));
          for (const cb of this.connectListeners) cb(ws.data.role, send);
          if (ws.data.role === "overlay") this.flushItemText();
        },
        message: (ws, bytes) => {
          let event: { name?: unknown; payload?: unknown };
          try {
            event = JSON.parse(typeof bytes === "string" ? bytes : bytes.toString("utf-8"));
          } catch {
            this.opts.logger.write(`warn [Server] Invalid message from ${ws.data.role} page`);
            return;
          }
          if (!event || typeof event.name !== "string") return;
          this.emit(event.name, event.payload, { role: ws.data.role });
        },
        close: (ws) => {
          this.clients.delete(ws);
        },
      },
    });
    const hosts = [`127.0.0.1:${this.port}`, `localhost:${this.port}`, ...DEV_HOSTS];
    this.allowedHosts = new Set(hosts);
    this.allowedOrigins = new Set(hosts.map((h) => `http://${h}`));
  }

  stop() {
    for (const c of this.clients) c.close(CLOSE_RESTART, "OmaExiled is stopping");
    this.server?.stop(true);
  }
}
