import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HostProcess, type HostMessage } from "../src/host";
import { Logger } from "../src/logger";

// Short paths: unix socket paths are limited to 107 bytes.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "oxh-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

// A stand-in for omaexiled-host: connects, says hello, records commands,
// exits on `quit`. For the "crash" socket the first run exits with code 3
// after 150 ms. Writes to <socket>.out.
const fakeBin = path.join(root, "fake-host");
fs.writeFileSync(
  fakeBin,
  `#!/usr/bin/env bun
const args = process.argv.slice(2);
const sock = args[args.indexOf("--socket") + 1];
const url = args[args.indexOf("--url") + 1];
const out = sock.replace(/\\.sock$/, ".out");
const exitAfter = sock.includes("crash") && require("node:fs").existsSync(out) ? 0 : sock.includes("crash") ? 150 : 0;
const log = (l) => require("node:fs").appendFileSync(out, l + "\\n");
log(JSON.stringify({ started: process.pid, url }));
let buf = "";
await Bun.connect({ unix: sock, socket: {
  open(s) { s.write(JSON.stringify({ type: "hello", version: "t", userAgent: "UA/1" }) + "\\n"); },
  data(s, d) {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      log(line);
      if (JSON.parse(line).type === "quit") process.exit(0);
    }
  },
  close() { process.exit(0); },
}});
if (exitAfter) setTimeout(() => process.exit(3), exitAfter);
`,
);
fs.chmodSync(fakeBin, 0o755);

function make(name: string, bin = fakeBin, idleStopMs?: number) {
  const lines: string[] = [];
  const logger = new Logger();
  logger.write = (m: string) => {
    lines.push(m);
  };
  const messages: HostMessage[] = [];
  let connects = 0;
  const host = new HostProcess({
    socketPath: path.join(root, `${name}.sock`),
    bin,
    url: "http://127.0.0.1:1234",
    logger,
    onMessage: (m) => messages.push(m),
    onConnected: () => connects++,
    onDisconnected: () => {},
    idleStopMs,
  });
  host.listen();
  return { host, lines, messages, connects: () => connects };
}

const out = (name: string) => {
  const p = path.join(root, `${name}.out`);
  return { p, read: () => (fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim().split("\n") : []) };
};

async function until(cond: () => boolean, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await Bun.sleep(20);
  }
}

describe("HostProcess", () => {
  test("missing binary: logged once, keeps running", () => {
    const { host, lines } = make("missing", path.join(root, "nope"));
    expect(host.ensureRunning()).toBe(false);
    expect(host.ensureRunning()).toBe(false);
    expect(lines.filter((l) => l.includes("not found"))).toHaveLength(1);
    expect(host.request({ type: "settings.open" })).toBe(false);
    host.close();
  });

  test("window requests start the host and are sent after hello", async () => {
    const o = out("req");
    const { host, connects } = make("req");
    host.request({ type: "settings.open" });
    host.request({ type: "settings.open" }); // deduplicated while starting
    host.request({ type: "browser.open", url: "https://www.pathofexile.com/trade2" });
    await until(() => o.read().length >= 3);
    expect(connects()).toBe(1);
    expect(host.userAgent).toBe("UA/1");
    const lines = o.read();
    expect(JSON.parse(lines[0]).url).toBe("http://127.0.0.1:1234");
    expect(lines.slice(1)).toEqual([
      '{"type":"settings.open"}',
      '{"type":"browser.open","url":"https://www.pathofexile.com/trade2"}',
    ]);
    expect([...host.openWindows].sort()).toEqual(["browser", "settings"]);
    // overlay commands go straight through while connected
    expect(host.send({ type: "overlay.hide" })).toBe(true);
    await until(() => o.read().length >= 4);
    await host.stop();
    expect(o.read().at(-1)).toBe('{"type":"quit"}');
    host.close();
  });

  test(
    "restarts after a crash with back-off",
    async () => {
      const o = out("crash");
      const { host, lines } = make("crash");
      host.ensureRunning();
      await until(() => o.read().filter((l) => l.includes("started")).length >= 2, 4000);
      expect(lines.some((l) => /Exited unexpectedly \(code 3\), restarting in 1000 ms/.test(l))).toBe(true);
      await host.stop();
      host.close();
    },
    { timeout: 8000 },
  );

  test("messages and window.closed", async () => {
    const { host, messages } = make("msg");
    host.request({ type: "settings.open" });
    await until(() => host.connected);
    const client = await Bun.connect({
      unix: path.join(root, "msg.sock"),
      socket: { data() {}, open() {} },
    });
    // a second connection replaces the first
    client.write(
      [
        JSON.stringify({ type: "hello", version: "2" }),
        JSON.stringify({ type: "overlay.state", mapped: true, keyboardFocus: false }),
        JSON.stringify({ type: "window.closed", window: "settings" }),
        "not json",
        "",
      ].join("\n"),
    );
    await until(() => messages.length >= 2);
    expect(messages[0]).toEqual({ type: "overlay.state", mapped: true, keyboardFocus: false });
    expect(host.openWindows.has("settings")).toBe(false);
    client.end();
    await host.stop();
    host.close();
  });

  test("stops after PoE2 closed and no window is open", async () => {
    const o = out("idle");
    const { host, lines } = make("idle", fakeBin, 300);
    host.setGamePresent(true);
    await until(() => host.connected);
    host.request({ type: "settings.open" });
    host.setGamePresent(false);
    await Bun.sleep(450);
    expect(host.running).toBe(true); // the settings window is open
    host.request({ type: "settings.close" });
    await until(() => !host.running, 2000);
    expect(lines.some((l) => l.includes("stopping the host"))).toBe(true);
    expect(o.read().at(-1)).toBe('{"type":"quit"}');
    host.close();
  });
});
