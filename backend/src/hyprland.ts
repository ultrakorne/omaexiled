// Hyprland IPC: the request socket (one connection per request) and the
// socket2 event stream. See docs/port-notes/08-hyprland-layershell-qt.md
// §2.2 and §4 for the protocol facts relied on here.
import type { Logger } from "./logger";

export function hyprSocketDir(env = process.env): string | null {
  const sig = env.HYPRLAND_INSTANCE_SIGNATURE;
  if (!sig) return null;
  return `${env.XDG_RUNTIME_DIR}/hypr/${sig}`;
}

export interface HyprClient {
  address: string; // "0x…"
  mapped: boolean;
  hidden: boolean;
  at: [number, number];
  size: [number, number];
  workspace: { id: number; name: string };
  floating: boolean;
  monitor: number;
  class: string;
  title: string;
  pid: number;
  xwayland: boolean;
  fullscreen: number;
}

export interface HyprMonitor {
  id: number;
  name: string;
  width: number; // pixels
  height: number;
  x: number; // logical
  y: number;
  scale: number;
  transform: number;
  focused: boolean;
  activeWorkspace: { id: number; name: string };
  specialWorkspace: { id: number; name: string };
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Logical (layout) size of a monitor: pixel size, swapped for 90/270°
// transforms, divided by the scale.
export function monitorLogicalRect(m: HyprMonitor): Rect {
  const rotated = m.transform % 2 === 1;
  const w = rotated ? m.height : m.width;
  const h = rotated ? m.width : m.height;
  return { x: m.x, y: m.y, width: Math.round(w / m.scale), height: Math.round(h / m.scale) };
}

export class Hyprland {
  private requestPath: string | null;
  private eventsPath: string | null;
  private listeners = new Set<(event: string, data: string) => void>();
  private connectListeners = new Set<() => void>();
  private stopped = false;
  private retry = 500;
  private socket2?: { end(): void };

  constructor(
    private logger: Logger,
    dir = hyprSocketDir(),
  ) {
    this.requestPath = dir ? `${dir}/.socket.sock` : null;
    this.eventsPath = dir ? `${dir}/.socket2.sock` : null;
  }

  get available() {
    return this.requestPath !== null;
  }

  // One request per connection: write once, read until Hyprland closes.
  request(cmd: string, timeoutMs = 2000): Promise<string> {
    const path = this.requestPath;
    if (!path) return Promise.reject(new Error("Hyprland is not running"));
    // The server reads 1023-byte chunks and waits for more after a full one.
    if (Buffer.byteLength(cmd) % 1023 === 0) cmd += " ";
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let done = false;
      const finish = (err?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(Buffer.concat(chunks).toString("utf8"));
      };
      const timer = setTimeout(() => {
        finish(new Error(`Hyprland request timed out: ${cmd.slice(0, 60)}`));
      }, timeoutMs);
      Bun.connect({
        unix: path,
        socket: {
          open(s) {
            s.write(cmd);
            s.flush();
          },
          data(_s, d) {
            chunks.push(Buffer.from(d));
          },
          close() {
            finish();
          },
          error(_s, e) {
            finish(e);
          },
        },
      }).catch((e) => finish(e));
    });
  }

  async json<T>(cmd: string): Promise<T> {
    return JSON.parse(await this.request(`j/${cmd}`)) as T;
  }

  // `/eval <lua>`: "ok" or "error: …" lines.
  async eval(lua: string): Promise<void> {
    const reply = (await this.request(`/eval ${lua}`)).trim();
    if (reply !== "ok") throw new Error(reply);
  }

  // `/repl <lua>`: the returned values, tab separated.
  async repl(lua: string): Promise<string> {
    return (await this.request(`/repl ${lua}`)).trim();
  }

  async dispatch(expr: string): Promise<void> {
    const reply = (await this.request(`/dispatch ${expr}`)).trim();
    if (reply !== "ok") throw new Error(reply);
  }

  async clients() {
    return this.json<HyprClient[]>("clients");
  }

  async monitors() {
    return this.json<HyprMonitor[]>("monitors");
  }

  async activeWindow(): Promise<HyprClient | null> {
    const w = await this.json<Partial<HyprClient>>("activewindow");
    return w && w.address ? (w as HyprClient) : null;
  }

  async cursorPos(): Promise<{ x: number; y: number }> {
    return this.json<{ x: number; y: number }>("cursorpos");
  }

  onEvent(cb: (event: string, data: string) => void) {
    this.listeners.add(cb);
  }

  // Called after every (re)connect of the event socket: state may have
  // changed while it was down.
  onConnect(cb: () => void) {
    this.connectListeners.add(cb);
  }

  // socket2: "EVENT>>DATA\n" lines; chunks are not line aligned.
  // Hyprland drops readers with 64 unread events, so read continuously and
  // reconnect on close.
  startEvents() {
    const path = this.eventsPath;
    if (!path || this.stopped) return;
    let buf = "";
    const decoder = new TextDecoder();
    const reconnect = () => {
      if (this.stopped) return;
      setTimeout(() => this.startEvents(), this.retry);
      this.retry = Math.min(this.retry * 2, 5000);
    };
    Bun.connect({
      unix: path,
      socket: {
        open: () => {
          this.retry = 500;
          for (const cb of this.connectListeners) cb();
        },
        data: (_s, d) => {
          buf += decoder.decode(d, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            const sep = line.indexOf(">>");
            if (sep < 0) continue;
            const event = line.slice(0, sep);
            const data = line.slice(sep + 2);
            for (const cb of this.listeners) {
              try {
                cb(event, data);
              } catch (e) {
                this.logger.write(`error [Hyprland] event handler: ${(e as Error).stack}`);
              }
            }
          }
        },
        close: () => {
          if (!this.stopped) this.logger.write("warn [Hyprland] Event socket closed, reconnecting");
          reconnect();
        },
        error: () => {},
      },
    })
      .then((s) => {
        this.socket2 = s;
      })
      .catch((e) => {
        this.logger.write(`error [Hyprland] Failed to connect to the event socket: ${e.message}`);
        reconnect();
      });
  }

  stop() {
    this.stopped = true;
    this.socket2?.end();
  }
}

// Lua string literal for generated code (UTF-8 passes through; control
// characters use Lua's decimal escapes).
export function luaString(s: string) {
  return (
    '"' +
    s.replace(/[\\"\x00-\x1f\x7f]/g, (c) =>
      c === "\\" || c === '"' ? "\\" + c : "\\" + String(c.charCodeAt(0)).padStart(3, "0"),
    ) +
    '"'
  );
}
