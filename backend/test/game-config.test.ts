import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { copyChord } from "../src/actions";
import { GameConfig, guessFileLocation, parseIni } from "../src/game-config";
import { Logger } from "../src/logger";

const FIXTURE = path.join(import.meta.dir, "fixtures/poe2_production_Config.ini");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omaexiled-gamecfg-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function logger() {
  const lines: string[] = [];
  const l = new Logger();
  l.write = (m: string) => {
    lines.push(m);
  };
  return { l, lines };
}

function iniWith(name: string, body: string) {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, body);
  return p;
}

describe("GameConfig", () => {
  test("copy chord from the real ini excerpt (BOM, WASD mode)", () => {
    const { l, lines } = logger();
    const cfg = new GameConfig(l, []);
    cfg.readConfig(FIXTURE);
    expect(cfg.showModsKey).toBe("Alt");
    expect(cfg.actualPath).toBe(FIXTURE);
    expect(copyChord(cfg.showModsKey)).toEqual({ mods: "CTRL ALT", key: "C" });
    expect(lines).toEqual([]);
  });

  test("defaults to Alt without an ini", () => {
    const { l, lines } = logger();
    const cfg = new GameConfig(l, [path.join(tmp, "missing.ini")]);
    cfg.readConfig("");
    expect(cfg.showModsKey).toBe("Alt");
    expect(lines).toEqual([
      "error [GameConfig] Failed to find game configuration file in the default location.",
    ]);
  });

  test("auto-detects the single readable candidate", () => {
    const cfg = new GameConfig(logger().l, [path.join(tmp, "nope.ini"), FIXTURE]);
    cfg.readConfig("");
    expect(cfg.actualPath).toBe(FIXTURE);
  });

  test("Shift as show-mods key -> Ctrl+Shift+C", () => {
    const p = iniWith("shift.ini", "[ACTION_KEYS]\nshow_advanced_item_descriptions=16\n");
    const cfg = new GameConfig(logger().l, []);
    cfg.readConfig(p);
    expect(cfg.showModsKey).toBe("Shift");
    expect(copyChord(cfg.showModsKey)).toEqual({ mods: "CTRL SHIFT", key: "C" });
  });

  test("Ctrl -> plain Ctrl+C; key with modifier", () => {
    const cfg = new GameConfig(logger().l, []);
    cfg.readConfig(iniWith("ctrl.ini", "[ACTION_KEYS]\nshow_advanced_item_descriptions=17\n"));
    expect(copyChord(cfg.showModsKey)).toEqual({ mods: "CTRL", key: "C" });
    const cfg2 = new GameConfig(logger().l, []);
    cfg2.readConfig(iniWith("mod.ini", "[ACTION_KEYS]\nshow_advanced_item_descriptions=90 1\n"));
    expect(cfg2.showModsKey).toBe("Shift + Z");
  });

  test("WASD section wins in wasd mode, ACTION_KEYS otherwise", () => {
    const body = (mode: string) =>
      `[GENERAL]\nuser_input_mode=${mode}\n[ACTION_KEYS]\nshow_advanced_item_descriptions=18\n[WASD_ACTION_KEYS]\nshow_advanced_item_descriptions=16\n`;
    const wasd = new GameConfig(logger().l, []);
    wasd.readConfig(iniWith("wasd.ini", body("wasd")));
    expect(wasd.showModsKey).toBe("Shift");
    const classic = new GameConfig(logger().l, []);
    classic.readConfig(iniWith("classic.ini", body("classic")));
    expect(classic.showModsKey).toBe("Alt");
  });

  test("bad values log EE2's messages", () => {
    const { l, lines } = logger();
    new GameConfig(l, []).readConfig(iniWith("bad1.ini", "[ACTION_KEYS]\nshow_advanced_item_descriptions=999\n"));
    new GameConfig(l, []).readConfig(iniWith("bad2.ini", "[ACTION_KEYS]\nshow_advanced_item_descriptions=18 7\n"));
    expect(lines).toEqual([
      "error [GameConfig] Failed to read key: 999.",
      "error [GameConfig] Failed to read modifier key: 18 7.",
    ]);
  });

  test("re-reads when the file changes", () => {
    const p = iniWith("change.ini", "[ACTION_KEYS]\nshow_advanced_item_descriptions=18\n");
    const cfg = new GameConfig(logger().l, []);
    cfg.readConfig(p);
    expect(cfg.showModsKey).toBe("Alt");
    expect(cfg.readConfig(p)).toBe(false);
    fs.writeFileSync(p, "[ACTION_KEYS]\nshow_advanced_item_descriptions=16\n");
    fs.utimesSync(p, new Date(), new Date(Date.now() + 5000));
    expect(cfg.readConfig(p)).toBe(true);
    expect(cfg.showModsKey).toBe("Shift");
  });
});

test("parseIni", () => {
  expect(parseIni("a=1\n[S]\n; c\nk = v x \r\n[T]\nz=")).toEqual({ "": { a: "1" }, S: { k: "v x" }, T: { z: "" } });
});

test("guessFileLocation: none, one, ambiguous", () => {
  expect(guessFileLocation([path.join(tmp, "x")])).toBeUndefined();
  expect(guessFileLocation([FIXTURE])).toBe(FIXTURE);
  expect(guessFileLocation([FIXTURE, FIXTURE])).toBeNull();
});
