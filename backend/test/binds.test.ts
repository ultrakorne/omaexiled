import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ShortcutAction } from "../../ipc/types";
import { DEFAULT_HOST_CONFIG } from "../src/app";
import { Binds, LEASE_RENEW, LEASE_SECONDS, generateBindsLua, planBinds } from "../src/binds";
import type { Hyprland } from "../src/hyprland";
import { Logger } from "../src/logger";

const opts = { showModsKey: "Alt", windowTitle: "Path of Exile 2" };

describe("planBinds", () => {
  test("default config", () => {
    const binds = planBinds(DEFAULT_HOST_CONFIG.shortcuts, opts);
    expect(binds.map((b) => [b.id, b.hypr.combo, b.mode])).toEqual([
      ["price-check", "CTRL + D", "consume"],
      ["price-check-locked", "CTRL + ALT + D", "consume"],
      ["toggle-overlay", "SHIFT + space", "consume"],
      ["item-check", "ALT + D", "consume"],
      ["chat-0", "F5", "consume"],
      ["chat-1", "F9", "consume"],
      ["close-panel", "Escape", "panel"],
    ]);
    expect(binds[0].keepModKeys).toBe(true);
  });

  test("game copy chord pass-through bind", () => {
    const binds = planBinds(DEFAULT_HOST_CONFIG.shortcuts, { ...opts, gameCopyBind: true });
    expect(binds.at(-1)).toMatchObject({ id: "game-copy", shortcut: "Ctrl + Alt + C", mode: "pass" });
    const shift = planBinds([], { ...opts, showModsKey: "Shift", gameCopyBind: true });
    expect(shift.at(-1)!.hypr.combo).toBe("CTRL + SHIFT + C");
  });

  test("ids for item-check actions, stash search and duplicates", () => {
    const shortcuts: ShortcutAction[] = [
      { shortcut: "F1", action: { type: "copy-item", target: "open-wiki" } },
      { shortcut: "F2", action: { type: "copy-item", target: "search-similar" } },
      { shortcut: "F3", action: { type: "stash-search", text: '"Exalted"' } },
      { shortcut: "F4", action: { type: "stash-search", text: "rings" } },
      { shortcut: "F6", action: { type: "trigger-event", target: "stopwatch-start-stop:3" } },
      { shortcut: "F7", action: { type: "copy-item", target: "open-wiki" } },
    ];
    expect(planBinds(shortcuts, opts).map((b) => b.id)).toEqual([
      "open-wiki",
      "search-similar",
      "stash-search-0",
      "stash-search-1",
      "event-stopwatch-start-stop:3",
      "open-wiki~2",
      "close-panel",
    ]);
  });

  test("two spellings of one combo: the first wins", () => {
    const lines: string[] = [];
    const logger = { write: (m: string) => lines.push(m) } as any;
    const binds = planBinds(
      [
        { shortcut: "Alt + Shift + D", action: { type: "stash-search", text: "a" } },
        { shortcut: "Shift + Alt + D", action: { type: "stash-search", text: "b" } },
      ],
      opts,
      logger,
    );
    expect(binds.filter((b) => b.hypr.combo === "SHIFT + ALT + D")).toHaveLength(1);
    expect(lines).toHaveLength(1);
  });

  test("a user Escape hotkey replaces close-panel", () => {
    const binds = planBinds([{ shortcut: "Escape", action: { type: "toggle-overlay" } }], opts);
    expect(binds.map((b) => b.id)).toEqual(["toggle-overlay"]);
  });

  test("ocr and unbindable hotkeys are skipped", () => {
    const binds = planBinds(
      [
        { shortcut: "F8", action: { type: "ocr-text", target: "heist-gems" } },
        { shortcut: "Ctrl + Pause", action: { type: "toggle-overlay" } },
      ],
      opts,
    );
    expect(binds.map((b) => b.id)).toEqual(["close-panel"]);
  });
});

describe("generateBindsLua", () => {
  const lua = generateBindsLua(planBinds(DEFAULT_HOST_CONFIG.shortcuts, { ...opts, gameCopyBind: true }), {
    windowTitle: 'Path of "Exile" 2',
  });

  test("action table", () => {
    expect(lua).toContain(`M.actions = {
  ["CTRL + D"] = { id = "price-check" },
  ["CTRL + ALT + D"] = { id = "price-check-locked" },
  ["SHIFT + space"] = { id = "toggle-overlay" },
  ["ALT + D"] = { id = "item-check" },
  ["F5"] = { id = "chat-0" },
  ["F9"] = { id = "chat-1" },
  ["Escape"] = { id = "close-panel", panel = true },
  ["CTRL + ALT + C"] = { id = "game-copy", pass = true },
}`);
  });

  test("game matcher and escaping", () => {
    expect(lua).toContain('M.title = "Path of \\"Exile\\" 2"');
    expect(lua).toContain('M.class = "steam_app_2694490"');
    expect(lua).toContain("return w ~= nil and (w.class == M.class or w.title == M.title)");
  });

  test("self-gating callback, set_enabled only", () => {
    expect(lua).toContain('hl.dispatch(hl.dsp.event("omaexiled:" .. a.id))');
    expect(lua).toContain("if not a or (a.panel and not M.panel) or not is_poe(hl.get_active_window()) then");
    // a dead or hung backend: the lease runs out and keys pass through
    expect(lua).toContain("local a = M.enabled and (M.lease or 0) >= os.time() and M.actions[combo]");
    expect(lua).toContain("auto_consuming = true");
    expect(lua).toContain("dont_inhibit = true");
    expect(lua).toContain('description = "OmaExiled: " .. a.id');
    expect(lua).toContain("b:set_enabled(true)");
    expect(lua).toContain("b:set_enabled(false)");
    // never remove binds: that would delete the user's binds on the combo
    const code = lua.replace(/--.*$/gm, "");
    expect(code).not.toMatch(/hl\.unbind\(|:remove\(\)|:unbind\(\)/);
  });

  test("rules", () => {
    expect(lua).toContain('match = { namespace = "^omaexiled$" }, no_anim = true');
    expect(lua).toContain('match = { title = "^OmaExiled Settings$" }');
    expect(lua).toContain('match = { title = "^OmaExiled Browser$" }');
    expect(lua).toContain("float = true");
    expect(lua).toContain("center = true");
  });

  test("Lua string escaping of control characters", () => {
    const l = generateBindsLua([], { windowTitle: "a\nb\\c" });
    expect(l).toContain('M.title = "a\\010b\\\\c"');
  });
});

describe("Binds lease", () => {
  function fakeHypr() {
    const calls: string[] = [];
    const hypr = {
      available: true,
      repl: async (lua: string) => (calls.push(`repl ${lua}`), "installed"),
      eval: async (lua: string) => {
        calls.push(`eval ${lua}`);
      },
      json: async () => [],
    } as unknown as Hyprland;
    const logger = new Logger();
    logger.write = () => {};
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omaexiled-binds-"));
    return { binds: new Binds(hypr, logger, dir), calls, dir };
  }
  const RENEW = 'eval local M = rawget(_G, "omaexiled") if M then M.lease = os.time() + 15 end';

  test("renewed right after every install", async () => {
    const { binds, calls, dir } = fakeHypr();
    const lua = binds.update(DEFAULT_HOST_CONFIG.shortcuts, opts);
    await binds.install(lua);
    expect(calls[0]).toStartWith("repl return dofile(");
    expect(calls[1]).toBe(RENEW);
    await binds.install(lua, true);
    expect(calls.filter((c) => c === RENEW)).toHaveLength(2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("renewed on a timer while running; cleared on shutdown", async () => {
    const { binds, calls, dir } = fakeHypr();
    binds.startLease(20);
    await Bun.sleep(75);
    const renewals = calls.filter((c) => c === RENEW).length;
    expect(renewals).toBeGreaterThanOrEqual(2);
    await binds.disable();
    expect(calls.at(-1)).toContain("M.enabled = false");
    expect(calls.at(-1)).toContain("M.lease = nil");
    const after = calls.length;
    await Bun.sleep(60);
    expect(calls.length).toBe(after);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("the default renewal interval is well inside the lease", () => {
    expect(LEASE_RENEW * 2).toBeLessThan(LEASE_SECONDS * 1000);
  });
});
