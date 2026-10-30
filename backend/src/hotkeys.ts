// EE2 hotkey strings ("Ctrl + Shift + Alt + D", ipc/KeyToCode.ts) to
// Hyprland bind combos, plus EE2's hotkey validation
// (main/src/shortcuts/Shortcuts.ts `updateActions`).
import { KeyToCode, mergeTwoHotkeys } from "../../ipc/KeyToCode";
import type { ShortcutAction } from "../../ipc/types";
import type { Logger } from "./logger";

// EE2 key name -> xkb keysym. Keys that change their keysym with Shift
// (digits, punctuation) and the keypad (NumLock dependent) are bound by
// physical key instead (`code:<evdev + 8>`), like Omarchy's own digit binds.
const KEYSYM: Record<string, string> = {
  Backspace: "BackSpace",
  Tab: "Tab",
  Enter: "Return",
  CapsLock: "Caps_Lock",
  Escape: "Escape",
  Space: "space",
  PageUp: "Prior",
  PageDown: "Next",
  End: "End",
  Home: "Home",
  ArrowLeft: "Left",
  ArrowUp: "Up",
  ArrowRight: "Right",
  ArrowDown: "Down",
  Insert: "Insert",
  Delete: "Delete",
};

// evdev key codes (linux/input-event-codes.h)
const EVDEV: Record<string, number> = {
  1: 2, 2: 3, 3: 4, 4: 5, 5: 6, 6: 7, 7: 8, 8: 9, 9: 10, 0: 11,
  Minus: 12,
  Equal: 13,
  BracketLeft: 26,
  BracketRight: 27,
  Semicolon: 39,
  Quote: 40,
  Backquote: 41,
  Backslash: 43,
  Comma: 51,
  Period: 52,
  Slash: 53,
  NumpadMultiply: 55,
  Numpad7: 71, Numpad8: 72, Numpad9: 73,
  NumpadSubtract: 74,
  Numpad4: 75, Numpad5: 76, Numpad6: 77,
  NumpadAdd: 78,
  Numpad1: 79, Numpad2: 80, Numpad3: 81, Numpad0: 82,
  NumpadDecimal: 83,
  NumpadDivide: 98,
};

const MODS: Record<string, string> = { Ctrl: "CTRL", Shift: "SHIFT", Alt: "ALT" };
// Hyprland modmask bits (`hyprctl binds -j`)
const MODMASK: Record<string, number> = { SHIFT: 1, CTRL: 4, ALT: 8 };

export interface HyprCombo {
  combo: string; // "CTRL + ALT + D", the string passed to hl.bind
  modmask: number;
  key: string; // keysym, "" for code: binds
  keycode: number; // xkb keycode for code: binds, else 0
}

// "Ctrl + Shift + D" -> "CTRL + SHIFT + D". null if a key is unknown.
export function hotkeyToHyprland(hotkey: string): HyprCombo | null {
  const parts = hotkey.split(" + ").map((k) => k.trim());
  const mods: string[] = [];
  let main: string | undefined;
  for (const part of parts) {
    if (MODS[part]) {
      if (!mods.includes(MODS[part])) mods.push(MODS[part]);
    } else if (main === undefined && part in KeyToCode) {
      main = part;
    } else {
      return null;
    }
  }
  // Hyprland needs modifiers first; keep EE2's canonical order.
  const ordered = ["CTRL", "SHIFT", "ALT"].filter((m) => mods.includes(m));
  const modmask = ordered.reduce((acc, m) => acc | MODMASK[m], 0);
  if (main === undefined) return null; // modifier-only hotkey: not bindable
  let key = "";
  let keycode = 0;
  let token: string;
  if (EVDEV[main] !== undefined) {
    keycode = EVDEV[main] + 8;
    token = `code:${keycode}`;
  } else if (KEYSYM[main]) {
    key = token = KEYSYM[main];
  } else {
    key = token = main; // A-Z, F1-F24: keysym names match EE2's
  }
  return { combo: [...ordered, token].join(" + "), modmask, key, keycode };
}

export const COPY_ITEM_BASE = "Ctrl + C";

export function copyItemShortcut(showModsKey: string) {
  return mergeTwoHotkeys(COPY_ITEM_BASE, showModsKey);
}

// EE2 `updateActions`: drop hotkeys the app itself injects (reserved) and
// every action on a hotkey used twice, except `toggle-overlay`. Same log
// strings. Does not mutate `input`.
export function validateShortcuts(
  input: ShortcutAction[],
  showModsKey: string,
  logger?: Logger,
): ShortcutAction[] {
  let actions = [...input];
  const copyItem = copyItemShortcut(showModsKey);
  if (copyItem !== COPY_ITEM_BASE) {
    actions.push({ shortcut: copyItem, action: { type: "test-only" } });
  }

  const allShortcuts = new Set([
    "Ctrl + C",
    "Ctrl + V",
    "Ctrl + A",
    "Ctrl + F",
    "Ctrl + Enter",
    "Home",
    "Delete",
    "Enter",
    "ArrowUp",
    "ArrowRight",
    "ArrowLeft",
    copyItem,
  ]);

  for (const action of actions) {
    if (allShortcuts.has(action.shortcut) && action.action.type !== "test-only") {
      logger?.write(
        `error [Shortcuts] Hotkey "${action.shortcut}" reserved by the game will not be registered.`,
      );
    }
  }
  actions = actions.filter((action) => !allShortcuts.has(action.shortcut));

  const duplicates = new Set<string>();
  for (const action of actions) {
    if (allShortcuts.has(action.shortcut)) {
      logger?.write(
        `error [Shortcuts] It is not possible to use the same hotkey "${action.shortcut}" for multiple actions.`,
      );
      duplicates.add(action.shortcut);
    } else {
      allShortcuts.add(action.shortcut);
    }
  }
  return actions.filter(
    (action) => !duplicates.has(action.shortcut) || action.action.type === "toggle-overlay",
  );
}
