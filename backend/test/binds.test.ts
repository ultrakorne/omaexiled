import { describe, expect, test } from "bun:test";
import type { ShortcutAction } from "../../ipc/types";
import { DEFAULT_HOST_CONFIG } from "../src/app";
import { generateBindsLua, planBinds } from "../src/binds";

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
