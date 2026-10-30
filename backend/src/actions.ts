// What happens when a hotkey fires: port of EE2 Shortcuts.register()
// callbacks, text-box.ts and pressKeysToCopyItemText. Keys are sent from
// here over Hyprland's request socket with `send_key_state` (modifiers as
// real key presses, see sendKeys), one step at a time, ~30 ms apart.
import type { ShortcutAction } from "../../ipc/types";
import type { Bind } from "./binds";
import type { HostClipboard } from "./clipboard";
import type { GameConfig } from "./game-config";
import { copyItemShortcut } from "./hotkeys";
import { luaString, type Hyprland } from "./hyprland";
import type { Logger } from "./logger";
import type { OverlayState } from "./overlay-state";

export interface KeyStep {
  mods: string; // Hyprland modifier names, "" for none
  key: string; // xkb keysym
  pauseBefore?: number; // ms, instead of STEP_DELAY
}

const STEP_DELAY = 30;
const SEND_SETTLE = 150;
// How long a key stays down; games read input per frame.
const KEY_HOLD = 20;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PLACEHOLDER_LAST = "@last";
const AUTO_CLEAR = [
  "#", // Global
  "%", // Party
  "@", // Whisper
  "$", // Trade
  "&", // Guild
  "/", // Command
];

const k = (key: string, mods = ""): KeyStep => ({ mods, key });

// EE2 text-box.ts typeInChat: the clipboard text and keys for a chat macro.
export function chatKeySequence(text: string, send: boolean): { clipboard: string; keys: KeyStep[] } {
  const keys: KeyStep[] = [];
  let clipboard: string;
  if (text.startsWith(PLACEHOLDER_LAST)) {
    // "@last ty": Ctrl+Enter opens chat with "@<last whisperer> "
    clipboard = text.slice(`${PLACEHOLDER_LAST} `.length);
    keys.push(k("Return", "CTRL"));
  } else if (text.endsWith(PLACEHOLDER_LAST)) {
    // "/invite @last": the pre-filled "@Name " minus its "@"
    clipboard = text.slice(0, -PLACEHOLDER_LAST.length);
    keys.push(k("Return", "CTRL"));
    keys.push(k("Home"));
    // press twice to focus input when using controller
    keys.push(k("Home"));
    keys.push(k("Delete"));
  } else {
    clipboard = text;
    keys.push(k("Return"));
    if (!AUTO_CLEAR.includes(text[0])) {
      keys.push(k("A", "CTRL"));
    }
  }

  keys.push(k("V", "CTRL"));

  if (send) {
    keys.push(k("Return"));
    // restore the last chat; the game needs a moment to send and close the
    // chat first, or this Enter sends the line again
    keys.push({ ...k("Return"), pauseBefore: SEND_SETTLE });
    keys.push(k("Up"));
    keys.push(k("Up"));
    keys.push(k("Escape"));
  }
  return { clipboard, keys };
}

// EE2 text-box.ts stashSearch
export function stashSearchSequence(text: string): { clipboard: string; keys: KeyStep[] } {
  return { clipboard: text, keys: [k("F", "CTRL"), k("V", "CTRL"), k("Return")] };
}

// EE2 pressKeysToCopyItemText: Ctrl + C merged with the game's "show
// advanced item descriptions" key; sendKeys presses the modifiers as keys,
// so a hotkey modifier the user still holds does no harm.
export function copyChord(showModsKey: string): KeyStep {
  const keys = copyItemShortcut(showModsKey).split(" + ");
  const mods = keys
    .filter((key) => key !== "C")
    .map((key) => ({ Ctrl: "CTRL", Shift: "SHIFT", Alt: "ALT" })[key] ?? key.toUpperCase());
  return k("C", mods.join(" "));
}

export interface ActionDeps {
  hypr: Hyprland;
  logger: Logger;
  clipboard: HostClipboard;
  gameConfig: GameConfig;
  overlay: OverlayState;
  logKeys(): boolean;
  // re-reads the game ini if it changed (and re-validates the hotkeys)
  refreshGameConfig(): void;
  broadcast(event: { name: "MAIN->CLIENT::widget-action"; payload: { target: string } }): void;
}

export class Actions {
  constructor(private deps: ActionDeps) {}

  // Keys only ever go to the PoE2 window: Return + Ctrl+V in a focused
  // terminal would run the clipboard as a command.
  private requireGame(): string {
    const address = this.deps.overlay.game?.address;
    if (!address) throw new Error("Path of Exile 2 window not found");
    return address;
  }

  // Sends key steps to the PoE2 window. Each step is one call into the
  // binds module's M.chord (binds.ts), which presses the modifiers as keys
  // (Wine/Proton ignores the modifier mask of a key event) and the key in
  // one go, then releases them after KEY_HOLD ms.
  async sendKeys(steps: KeyStep[]) {
    const window = luaString(`address:${this.requireGame()}`);
    for (let i = 0; i < steps.length; i++) {
      if (i > 0) await sleep(steps[i].pauseBefore ?? STEP_DELAY);
      const { mods, key } = steps[i];
      await this.deps.hypr.eval(
        `_G.omaexiled.chord(${window}, ${luaString(mods)}, ${luaString(key)}, ${KEY_HOLD})`,
      );
      await sleep(KEY_HOLD);
    }
  }

  async runBind(bind: Bind) {
    const action = bind.action;
    const detail = "text" in action ? ` ${JSON.stringify(action.text)}` : "target" in action ? ` ${action.target}` : "";
    this.deps.logger.write(`info [Shortcuts] ${bind.shortcut}: ${action.type}${detail}`);
    switch (action.type) {
      case "toggle-overlay":
        this.deps.overlay.toggleOverlay();
        break;
      case "paste-in-chat":
        await this.typeInChat(action.text, action.send);
        break;
      case "trigger-event":
        this.deps.broadcast({ name: "MAIN->CLIENT::widget-action", payload: { target: action.target } });
        break;
      case "stash-search":
        await this.stashSearch(action.text);
        break;
      case "copy-item":
        await this.copyItem(action);
        break;
      case "close-panel":
        this.deps.overlay.closePanel();
        break;
      case "game-copy":
        await this.gameCopy();
        break;
    }
  }

  // Resolves with the item text, or null when the game copied nothing.
  async copyItem(action: Extract<ShortcutAction["action"], { type: "copy-item" }>): Promise<string | null> {
    const { overlay, clipboard, gameConfig } = this.deps;
    // the ini may have changed since the last HostConfig
    this.deps.refreshGameConfig();
    const pressPosition = await overlay.cursorInSurface();
    this.requireGame();
    const chord = copyChord(gameConfig.showModsKey);

    return clipboard
      .readItemText(() => this.sendKeys([chord]))
      .then((text) => {
        overlay.tracker.stop();
        overlay.sendItemText({
          target: action.target,
          clipboard: text,
          position: pressPosition,
          focusOverlay: Boolean(action.focusOverlay),
        });
        if (action.focusOverlay && overlay.wasUsedRecently) {
          overlay.assertOverlayActive();
        }
        return text;
      })
      .catch(() => null);
  }

  // Trigger modes where the game's own copy chord did the copying: show the
  // panel read-only (focusOverlay without activating, like `omarchy_new`).
  priceCheckCopiedText(text: string, position: { x: number; y: number }) {
    this.deps.overlay.tracker.stop();
    this.deps.overlay.sendItemText({ target: "price-check", clipboard: text, position, focusOverlay: true });
  }

  async gameCopy() {
    const position = await this.deps.overlay.cursorInSurface();
    try {
      const text = await this.deps.clipboard.waitForGameCopy();
      this.priceCheckCopiedText(text, position);
    } catch {}
  }

  async typeInChat(text: string, send: boolean) {
    this.requireGame();
    const seq = chatKeySequence(text, send);
    const ran = await this.deps.clipboard.restoreShortly(async (write) => {
      await write(seq.clipboard);
      await sleep(STEP_DELAY);
      await this.sendKeys(seq.keys);
    });
    if (!ran && this.deps.logKeys()) this.deps.logger.write("debug [Shortcuts] Chat command throttled");
  }

  async stashSearch(text: string) {
    this.requireGame();
    const seq = stashSearchSequence(text);
    await this.deps.clipboard.restoreShortly(async (write) => {
      this.deps.overlay.assertGameActive();
      await write(seq.clipboard);
      await sleep(STEP_DELAY);
      await this.sendKeys(seq.keys);
    });
  }
}
