import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Logger } from "../src/logger";
import { ShellSocket, ctlRequest, type ShellState } from "../src/shell";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oxs-"));
let state: ShellState = {
  running: true,
  gameDetected: false,
  gameFocused: false,
  league: "Standard",
  leagueId: "Standard",
  overlayKey: "Shift + Space",
  url: "http://127.0.0.1:8584",
  configDir: "/c",
  hostRunning: false,
};
const calls: [string, string[]][] = [];
const shell = new ShellSocket({
  dir,
  version: "1.2.3",
  logger: new Logger(),
  state: () => state,
  command: async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === "fail") throw new Error("nope");
    return { echo: args };
  },
});
shell.listen();
afterAll(() => {
  shell.close();
  expect(fs.existsSync(path.join(dir, "shell.sock"))).toBe(false);
  expect(fs.existsSync(path.join(dir, "shell.ready"))).toBe(false);
  fs.rmSync(dir, { recursive: true, force: true });
});

function client() {
  const lines: any[] = [];
  let buf = "";
  const p = Bun.connect({
    unix: path.join(dir, "shell.sock"),
    socket: {
      data(_s, d) {
        buf += d.toString();
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          lines.push(JSON.parse(buf.slice(0, i)));
          buf = buf.slice(i + 1);
        }
      },
    },
  });
  return { p, lines };
}

test("shell.ready holds the pid", () => {
  expect(fs.readFileSync(path.join(dir, "shell.ready"), "utf8")).toBe(String(process.pid));
});

test("hello, state, widget commands, state broadcast", async () => {
  const c = client();
  const s = await c.p;
  await Bun.sleep(50);
  expect(c.lines[0]).toEqual({ v: 1, type: "hello", app: "OmaExiled", version: "1.2.3", pid: process.pid });
  expect(c.lines[1]).toEqual({ v: 1, type: "state", ...state });
  // a command split across two writes
  s.write('{"v":1,"type":"open-');
  await Bun.sleep(20);
  s.write('settings"}\n{"v":1,"type":"open-browser","url":"https://x"}\n{"v":1,"type":"bogus"}\nnot json\n');
  await Bun.sleep(50);
  expect(calls.slice(-2)).toEqual([
    ["open-settings", []],
    ["open-browser", ["https://x"]],
  ]);
  expect(c.lines.slice(2)).toEqual([
    { v: 1, type: "error", message: "unknown command bogus" },
    { v: 1, type: "error", message: "bad json" },
  ]);
  state = { ...state, gameDetected: true };
  shell.broadcastState();
  shell.broadcastState(); // unchanged: not re-sent
  await Bun.sleep(30);
  expect(c.lines.filter((l) => l.type === "state")).toHaveLength(2);
  expect(c.lines.at(-1).gameDetected).toBe(true);
  s.end();
});

test("ctl: one request, one reply", async () => {
  expect(await ctlRequest(path.join(dir, "shell.sock"), "status", ["a", "b"])).toEqual({
    ok: true,
    result: { echo: ["a", "b"] },
    error: undefined,
  });
  expect(await ctlRequest(path.join(dir, "shell.sock"), "fail", [])).toEqual({
    ok: false,
    result: undefined,
    error: "nope",
  });
  await expect(ctlRequest(path.join(dir, "missing.sock"), "status", [])).rejects.toThrow("OmaExiled is not running");
});
