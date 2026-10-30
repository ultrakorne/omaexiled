import { describe, expect, test } from "bun:test";
import type { ShortcutAction } from "../../ipc/types";
import { copyItemShortcut, hotkeyToHyprland, validateShortcuts } from "../src/hotkeys";
import { Logger } from "../src/logger";

function quietLogger() {
  const lines: string[] = [];
  const logger = new Logger();
  logger.write = (m: string) => {
    lines.push(m);
  };
  return { logger, lines };
}

describe("hotkeyToHyprland", () => {
  test.each([
    ["Ctrl + D", "CTRL + D", 4],
    ["Ctrl + Alt + D", "CTRL + ALT + D", 12],
    ["Alt + D", "ALT + D", 8],
    ["Shift + Space", "SHIFT + space", 1],
    ["Ctrl + Shift + Alt + F", "CTRL + SHIFT + ALT + F", 13],
    ["Shift + Alt + D", "SHIFT + ALT + D", 9],
    ["F5", "F5", 0],
    ["F24", "F24", 0],
    ["Enter", "Return", 0],
    ["Escape", "Escape", 0],
    ["Backspace", "BackSpace", 0],
    ["PageUp", "Prior", 0],
    ["PageDown", "Next", 0],
    ["ArrowLeft", "Left", 0],
    ["ArrowDown", "Down", 0],
    ["CapsLock", "Caps_Lock", 0],
    ["Ctrl + Delete", "CTRL + Delete", 4],
  ])("%s -> %s", (ee2, combo, modmask) => {
    const c = hotkeyToHyprland(ee2)!;
    expect(c.combo).toBe(combo);
    expect(c.modmask).toBe(modmask);
    expect(c.keycode).toBe(0);
  });

  test.each([
    ["1", "code:10"],
    ["0", "code:19"],
    ["Ctrl + 5", "CTRL + code:14"],
    ["Shift + 1", "SHIFT + code:10"],
    ["Minus", "code:20"],
    ["Equal", "code:21"],
    ["BracketLeft", "code:34"],
    ["BracketRight", "code:35"],
    ["Semicolon", "code:47"],
    ["Quote", "code:48"],
    ["Backquote", "code:49"],
    ["Backslash", "code:51"],
    ["Comma", "code:59"],
    ["Period", "code:60"],
    ["Slash", "code:61"],
    ["Numpad0", "code:90"],
    ["Numpad7", "code:79"],
    ["NumpadAdd", "code:86"],
    ["NumpadDivide", "code:106"],
  ])("physical key %s -> %s", (ee2, combo) => {
    const c = hotkeyToHyprland(ee2)!;
    expect(c.combo).toBe(combo);
    expect(c.key).toBe("");
    expect(c.keycode).toBeGreaterThan(8);
  });

  test("modifiers are emitted first in canonical order", () => {
    expect(hotkeyToHyprland("Alt + Ctrl + D")!.combo).toBe("CTRL + ALT + D");
    expect(hotkeyToHyprland("Alt + Shift + D")!.combo).toBe("SHIFT + ALT + D");
  });

  test("unknown keys and modifier-only hotkeys are rejected", () => {
    expect(hotkeyToHyprland("Ctrl + Pause")).toBeNull();
    expect(hotkeyToHyprland("Ctrl")).toBeNull();
    expect(hotkeyToHyprland("Ctrl + D + E")).toBeNull();
    expect(hotkeyToHyprland("")).toBeNull();
  });
});

describe("copyItemShortcut", () => {
  test("merges Ctrl + C with the show-mods key", () => {
    expect(copyItemShortcut("Alt")).toBe("Ctrl + Alt + C");
    expect(copyItemShortcut("Shift")).toBe("Ctrl + Shift + C");
    expect(copyItemShortcut("Ctrl")).toBe("Ctrl + C");
  });
});

const pc = (shortcut: string, extra: Partial<ShortcutAction> = {}): ShortcutAction => ({
  shortcut,
  action: { type: "copy-item", target: "price-check", focusOverlay: false },
  ...extra,
});

describe("validateShortcuts (EE2 Shortcuts.updateActions)", () => {
  test("reserved hotkeys are dropped with EE2's message", () => {
    const { logger, lines } = quietLogger();
    const reserved = ["Ctrl + C", "Ctrl + V", "Ctrl + A", "Ctrl + F", "Ctrl + Enter", "Home", "Delete", "Enter", "ArrowUp", "ArrowRight", "ArrowLeft", "Ctrl + Alt + C"];
    const out = validateShortcuts([...reserved.map((s) => pc(s)), pc("Ctrl + D")], "Alt", logger);
    expect(out.map((a) => a.shortcut)).toEqual(["Ctrl + D"]);
    expect(lines).toEqual(
      reserved.map((s) => `error [Shortcuts] Hotkey "${s}" reserved by the game will not be registered.`),
    );
  });

  test("the copy chord follows the game's show-mods key", () => {
    const out = validateShortcuts([pc("Ctrl + Alt + C"), pc("Ctrl + Shift + C")], "Shift");
    expect(out.map((a) => a.shortcut)).toEqual(["Ctrl + Alt + C"]);
  });

  test("duplicates disable every action on the hotkey except toggle-overlay", () => {
    const { logger, lines } = quietLogger();
    const out = validateShortcuts(
      [
        pc("Ctrl + D"),
        { shortcut: "Ctrl + D", action: { type: "paste-in-chat", text: "/hideout", send: true } },
        { shortcut: "Shift + Space", action: { type: "toggle-overlay" } },
        { shortcut: "Shift + Space", action: { type: "stash-search", text: "x" } },
        pc("Alt + D"),
      ],
      "Alt",
      logger,
    );
    expect(out.map((a) => `${a.shortcut}:${a.action.type}`)).toEqual([
      "Shift + Space:toggle-overlay",
      "Alt + D:copy-item",
    ]);
    expect(lines).toEqual([
      'error [Shortcuts] It is not possible to use the same hotkey "Ctrl + D" for multiple actions.',
      'error [Shortcuts] It is not possible to use the same hotkey "Shift + Space" for multiple actions.',
    ]);
  });

  test("does not mutate the input", () => {
    const input = [pc("Ctrl + D")];
    validateShortcuts(input, "Alt");
    expect(input).toHaveLength(1);
  });
});
