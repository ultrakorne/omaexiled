// Port of EE2 main/src/RemoteLogger.ts: every line goes to stderr (the
// journal under systemd) and to the renderer as `MAIN->CLIENT::log-entry`.
// New WebSocket clients get the history once (see server.ts).

const HISTORY_LINES = 2000;

export class Logger {
  private lines: string[] = [];
  private listeners = new Set<(message: string) => void>();

  get history() {
    return this.lines.join("");
  }

  // Message convention (EE2): "<level> [<Component>] <text>",
  // level = info | warn | error | debug.
  write(message: string) {
    message = `[${new Date().toLocaleTimeString()}] ${message}\n`;
    this.lines.push(message);
    if (this.lines.length > HISTORY_LINES) {
      this.lines.splice(0, this.lines.length - HISTORY_LINES);
    }
    process.stderr.write(message);
    for (const cb of this.listeners) cb(message);
  }

  onWrite(cb: (message: string) => void) {
    this.listeners.add(cb);
  }
}
