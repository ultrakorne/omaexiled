// shell.sock: the omarchy-shell bar widget (replaces EE2's tray, see
// docs/port-notes/09-omarchy-shell-plugin.md §8) and `omaexiled ctl`.
// NDJSON, every message has `v: 1` and `type`. On connect: `hello`, then
// the full `state`, re-sent on every change. `ctl` requests get exactly one
// `reply` with the same `id`.
import fs from "node:fs";
import path from "node:path";
import type { Socket } from "bun";
import type { Logger } from "./logger";

interface Conn {
  buf: string;
}

export interface ShellState {
  running: true;
  gameDetected: boolean;
  gameFocused: boolean;
  league: string | null;
  leagueId: string | null;
  overlayKey: string;
  url: string;
  configDir: string;
  hostRunning: boolean;
}

export interface ShellOptions {
  dir: string;
  version: string;
  logger: Logger;
  state(): ShellState;
  // widget commands and ctl requests; the result is the reply payload
  command(cmd: string, args: string[], msg: Record<string, unknown>): Promise<unknown>;
}

const line = (m: object) => JSON.stringify({ v: 1, ...m }) + "\n";

export class ShellSocket {
  private clients = new Set<Socket<Conn>>();
  private listener?: { stop(closeActive?: boolean): void };
  private lastState = "";
  readonly sockPath: string;
  readonly readyPath: string;

  constructor(private opts: ShellOptions) {
    this.sockPath = path.join(opts.dir, "shell.sock");
    this.readyPath = path.join(opts.dir, "shell.ready");
  }

  listen() {
    fs.rmSync(this.sockPath, { force: true });
    const self = this;
    this.listener = Bun.listen<Conn>({
      unix: this.sockPath,
      socket: {
        open(s) {
          s.data = { buf: "" };
          self.clients.add(s);
          s.write(line({ type: "hello", app: "OmaExiled", version: self.opts.version, pid: process.pid }));
          s.write(line({ type: "state", ...self.opts.state() }));
        },
        data(s, chunk) {
          s.data.buf += chunk.toString();
          let i: number;
          while ((i = s.data.buf.indexOf("\n")) >= 0) {
            const raw = s.data.buf.slice(0, i);
            s.data.buf = s.data.buf.slice(i + 1);
            if (!raw.trim()) continue;
            let msg: Record<string, unknown>;
            try {
              msg = JSON.parse(raw);
            } catch {
              s.write(line({ type: "error", message: "bad json" }));
              continue;
            }
            self.handle(s, msg);
          }
        },
        close(s) {
          self.clients.delete(s);
        },
        error(s) {
          self.clients.delete(s);
        },
      },
    });
    fs.writeFileSync(this.readyPath, String(process.pid));
  }

  private async handle(s: Socket<Conn>, msg: Record<string, unknown>) {
    const type = String(msg.type ?? "");
    if (type === "ctl") {
      const id = msg.id ?? null;
      const cmd = String(msg.cmd ?? "");
      const args = Array.isArray(msg.args) ? msg.args.map(String) : [];
      try {
        const result = await this.opts.command(cmd, args, msg);
        s.write(line({ type: "reply", id, ok: true, result: result ?? null }));
      } catch (e) {
        s.write(line({ type: "reply", id, ok: false, error: (e as Error).message }));
      }
      return;
    }
    const args = typeof msg.url === "string" ? [msg.url] : [];
    switch (type) {
      case "open-settings":
      case "quit":
      case "open-browser":
      case "toggle-overlay":
        try {
          await this.opts.command(type, args, msg);
        } catch (e) {
          s.write(line({ type: "error", message: (e as Error).message }));
        }
        break;
      default:
        s.write(line({ type: "error", message: `unknown command ${type}` }));
    }
  }

  broadcastState() {
    const state = line({ type: "state", ...this.opts.state() });
    if (state === this.lastState) return;
    this.lastState = state;
    for (const c of this.clients) c.write(state);
  }

  error(message: string) {
    for (const c of this.clients) c.write(line({ type: "error", message }));
  }

  close() {
    this.listener?.stop(true);
    fs.rmSync(this.sockPath, { force: true });
    fs.rmSync(this.readyPath, { force: true });
  }
}

// `omaexiled ctl <cmd> [args]`: one request, one reply.
export function ctlRequest(sockPath: string, cmd: string, args: string[], timeoutMs = 15000): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const id = `${process.pid}-${Date.now()}`;
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("timed out waiting for the backend")), timeoutMs);
    Bun.connect({
      unix: sockPath,
      socket: {
        open(s) {
          s.write(line({ type: "ctl", id, cmd, args }));
          s.flush();
        },
        data(s, chunk) {
          buf += chunk.toString();
          let i: number;
          while ((i = buf.indexOf("\n")) >= 0) {
            const raw = buf.slice(0, i);
            buf = buf.slice(i + 1);
            let msg: { type?: string; id?: unknown; ok?: boolean; result?: unknown; error?: string };
            try {
              msg = JSON.parse(raw);
            } catch {
              continue;
            }
            if (msg.type === "reply" && msg.id === id) {
              clearTimeout(timer);
              resolve({ ok: Boolean(msg.ok), result: msg.result, error: msg.error });
              s.end(); // runs close() synchronously: settle first
            }
          }
        },
        close() {
          clearTimeout(timer);
          reject(new Error("the backend closed the connection"));
        },
        error(_s, e) {
          clearTimeout(timer);
          reject(e);
        },
      },
    }).catch((e) => {
      clearTimeout(timer);
      reject(new Error(`OmaExiled is not running (${(e as Error).message})`));
    });
  });
}
