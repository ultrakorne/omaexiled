// The Qt host (overlay layer surface, settings window, in-app browser).
// The backend listens on host.sock (NDJSON) and starts
// `omaexiled-host --socket <path> --url <backend url>`, which connects back.
// Started when PoE2 appears or a window is requested, restarted after a
// crash, stopped 10 minutes after PoE2 closed with no window open.
import fs from "node:fs";
import type { Socket } from "bun";
import type { Logger } from "./logger";

const IDLE_STOP = 10 * 60 * 1000;
const STABLE_AFTER = 60 * 1000;
const QUIT_GRACE = 3000;

export type HostMessage =
  | { type: "hello"; version?: string; userAgent?: string }
  | { type: "overlay.state"; mapped: boolean; keyboardFocus: boolean }
  | { type: "window.closed"; window: "settings" | "browser" }
  | { type: "cookies"; cookies: unknown[] }
  | { type: "log"; level?: string; message?: string };

interface Conn {
  buf: string;
}

export interface HostOptions {
  socketPath: string;
  bin: string;
  url: string;
  logger: Logger;
  onMessage(msg: HostMessage): void;
  onConnected(): void;
  onDisconnected(): void;
  idleStopMs?: number; // tests
}

export class HostProcess {
  private listener?: { stop(closeActive?: boolean): void };
  private conn?: Socket<Conn>;
  private proc?: Bun.Subprocess;
  private wanted = false;
  private startedAt = 0;
  private backoff = 1000;
  private restartTimer?: ReturnType<typeof setTimeout>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private missingLogged = false;
  // sent once the host connects (window requests while it starts)
  private queue: object[] = [];
  private gamePresent = false;
  readonly openWindows = new Set<string>();
  userAgent: string | null = null;
  version: string | null = null;

  constructor(private opts: HostOptions) {}

  get connected() {
    return this.conn != null;
  }

  get running() {
    return this.proc != null && this.proc.exitCode == null && this.proc.signalCode == null;
  }

  listen() {
    fs.rmSync(this.opts.socketPath, { force: true });
    const self = this;
    this.listener = Bun.listen<Conn>({
      unix: this.opts.socketPath,
      socket: {
        open(s) {
          s.data = { buf: "" };
          if (self.conn && self.conn !== s) self.conn.end();
          self.conn = s;
        },
        data(s, chunk) {
          s.data.buf += chunk.toString();
          let i: number;
          while ((i = s.data.buf.indexOf("\n")) >= 0) {
            const raw = s.data.buf.slice(0, i);
            s.data.buf = s.data.buf.slice(i + 1);
            if (!raw.trim()) continue;
            let msg: HostMessage;
            try {
              msg = JSON.parse(raw);
            } catch {
              self.opts.logger.write("warn [Host] Invalid message from the host");
              continue;
            }
            self.handle(s, msg);
          }
        },
        close(s) {
          self.dropConn(s);
        },
        error(s) {
          self.dropConn(s);
        },
      },
    });
  }

  private handle(s: Socket<Conn>, msg: HostMessage) {
    if (msg.type === "hello") {
      this.userAgent = msg.userAgent || null;
      this.version = msg.version || null;
      this.opts.logger.write(`info [Host] Connected (v${msg.version ?? "?"})`);
      this.opts.onConnected();
      const queued = this.queue;
      this.queue = [];
      for (const m of queued) this.write(s, m);
      return;
    }
    if (msg.type === "window.closed") {
      this.openWindows.delete(msg.window);
      this.updateIdle();
    } else if (msg.type === "log") {
      this.opts.logger.write(`${msg.level ?? "info"} [Host] ${msg.message ?? ""}`);
      return;
    }
    this.opts.onMessage(msg);
  }

  private dropConn(s: Socket<Conn>) {
    if (this.conn !== s) return;
    this.conn = undefined;
    this.openWindows.clear();
    this.opts.onDisconnected();
    this.updateIdle();
  }

  private write(s: Socket<Conn>, msg: object) {
    s.write(JSON.stringify(msg) + "\n");
    s.flush();
  }

  // Overlay commands are only meaningful for a connected host (state is
  // re-sent on connect); returns false when not connected.
  send(msg: object): boolean {
    if (!this.conn) return false;
    this.write(this.conn, msg);
    return true;
  }

  // Window commands start the host if needed and wait for it.
  request(msg: { type: string; [k: string]: unknown }) {
    if (msg.type === "settings.open") this.openWindows.add("settings");
    if (msg.type === "browser.open") this.openWindows.add("browser");
    if (msg.type === "settings.close") {
      this.openWindows.delete("settings");
      this.updateIdle();
    }
    if (this.send(msg)) return true;
    this.queue = this.queue.filter((m) => (m as { type: string }).type !== msg.type);
    this.queue.push(msg);
    return this.ensureRunning();
  }

  setGamePresent(present: boolean) {
    this.gamePresent = present;
    if (present) this.ensureRunning();
    this.updateIdle();
  }

  private updateIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    if (!this.wanted || this.gamePresent || this.openWindows.size > 0) return;
    this.idleTimer = setTimeout(() => {
      this.opts.logger.write("info [Host] Path of Exile 2 closed 10 minutes ago, stopping the host");
      this.stop();
    }, this.opts.idleStopMs ?? IDLE_STOP);
  }

  ensureRunning(): boolean {
    this.wanted = true;
    this.updateIdle();
    if (this.running) return true;
    if (this.restartTimer) return true; // a restart is scheduled
    return this.spawn();
  }

  private spawn(): boolean {
    let ok = false;
    try {
      fs.accessSync(this.opts.bin, fs.constants.X_OK);
      ok = true;
    } catch {}
    if (!ok) {
      if (!this.missingLogged) {
        this.missingLogged = true;
        this.opts.logger.write(
          `error [Host] ${this.opts.bin} not found; the overlay and the settings window are unavailable (build host/)`,
        );
      }
      return false;
    }
    this.missingLogged = false;
    let proc: Bun.Subprocess;
    try {
      // Chromium children inherit stdout/stderr: the protocol is host.sock.
      proc = Bun.spawn([this.opts.bin, "--socket", this.opts.socketPath, "--url", this.opts.url], {
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
      });
    } catch (e) {
      this.opts.logger.write(`error [Host] Failed to start: ${(e as Error).message}`);
      return false;
    }
    this.proc = proc;
    this.startedAt = Date.now();
    this.opts.logger.write(`info [Host] Started (pid ${proc.pid})`);
    proc.exited.then((code) => {
      if (this.proc !== proc) return;
      this.proc = undefined;
      if (!this.wanted) {
        this.opts.logger.write("info [Host] Stopped");
        return;
      }
      if (Date.now() - this.startedAt > STABLE_AFTER) this.backoff = 1000;
      this.opts.logger.write(
        `error [Host] Exited unexpectedly (${proc.signalCode ?? `code ${code}`}), restarting in ${this.backoff} ms`,
      );
      this.restartTimer = setTimeout(() => {
        this.restartTimer = undefined;
        if (this.wanted) this.spawn();
      }, this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30_000);
    });
    return true;
  }

  stop() {
    this.wanted = false;
    clearTimeout(this.idleTimer);
    clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    this.queue = [];
    this.send({ type: "quit" });
    const proc = this.proc;
    if (!proc) return Promise.resolve();
    const kill = setTimeout(() => proc.kill("SIGTERM"), QUIT_GRACE);
    return proc.exited.then(() => clearTimeout(kill));
  }

  close() {
    this.listener?.stop(true);
    fs.rmSync(this.opts.socketPath, { force: true });
  }

  status() {
    return {
      running: this.running,
      connected: this.connected,
      pid: this.proc?.pid ?? null,
      version: this.version,
      userAgent: this.userAgent,
      openWindows: [...this.openWindows],
      binary: this.opts.bin,
    };
  }
}
