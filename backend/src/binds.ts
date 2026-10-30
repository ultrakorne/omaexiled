// Hyprland binds for HostConfig.shortcuts (DESIGN.md "Hotkeys").
//
// One self-gating Lua bind per combo, created once per Lua state and later
// only enabled/disabled (hl.unbind and :remove() would also delete the
// user's binds on the same combo). The callback passes the key through
// unless the backend is alive, PoE2 is the active window and the combo maps
// to an action; then it posts `custom>>omaexiled:<id>` on socket2.
//
// "Alive" is a lease: the backend renews `_G.omaexiled.lease` (os.time()
// seconds) every LEASE_RENEW ms, so a killed or hung backend stops eating
// PoE2's keys within LEASE_SECONDS.
import fs from "node:fs";
import path from "node:path";
import type { ShortcutAction } from "../../ipc/types";
import { copyItemShortcut, hotkeyToHyprland, validateShortcuts, type HyprCombo } from "./hotkeys";
import { luaString, type Hyprland } from "./hyprland";
import type { Logger } from "./logger";

export const GAME_CLASS = "steam_app_2694490";
export const LAYER_NAMESPACE = "omaexiled";
export const SETTINGS_TITLE = "OmaExiled Settings";
export const BROWSER_TITLE = "OmaExiled Browser";
export const LEASE_SECONDS = 15;
export const LEASE_RENEW = 5000;

export type BoundAction =
  | ShortcutAction["action"]
  | { type: "close-panel" }
  | { type: "game-copy" };

export interface Bind {
  id: string;
  shortcut: string; // EE2 hotkey string
  hypr: HyprCombo;
  // consume: the key is eaten when the action runs
  // pass: the action runs and the key still reaches the game
  // panel: like consume, but only while a panel is visible
  mode: "consume" | "pass" | "panel";
  keepModKeys?: boolean;
  action: BoundAction;
}

export interface BindOptions {
  showModsKey: string;
  windowTitle: string;
  // Trigger mode: also price-check when the user presses the game's own
  // copy chord (the key still reaches the game).
  gameCopyBind?: boolean;
}

function baseId(entry: ShortcutAction, counters: Map<string, number>): string | null {
  const a = entry.action;
  const next = (prefix: string) => {
    const n = counters.get(prefix) ?? 0;
    counters.set(prefix, n + 1);
    return `${prefix}-${n}`;
  };
  switch (a.type) {
    case "copy-item":
      if (a.target === "price-check") return a.focusOverlay ? "price-check-locked" : "price-check";
      return a.target;
    case "paste-in-chat":
      return next("chat");
    case "stash-search":
      return next("stash-search");
    case "toggle-overlay":
      return "toggle-overlay";
    case "trigger-event":
      return `event-${a.target}`;
    default:
      return null; // ocr-text (Windows only), test-only
  }
}

// HostConfig.shortcuts -> the binds to install, in EE2's order.
export function planBinds(shortcuts: ShortcutAction[], opts: BindOptions, logger?: Logger): Bind[] {
  const valid = validateShortcuts(shortcuts, opts.showModsKey, logger);
  const binds: Bind[] = [];
  const ids = new Set<string>();
  const combos = new Map<string, Bind>();
  const counters = new Map<string, number>();
  for (const entry of valid) {
    let id = baseId(entry, counters);
    if (!id) continue;
    id = id.replace(/[^A-Za-z0-9:_-]/g, "_");
    for (let n = 2; ids.has(id); n++) id = `${id.replace(/~\d+$/, "")}~${n}`;
    const hypr = hotkeyToHyprland(entry.shortcut);
    if (!hypr) {
      logger?.write(`error [Shortcuts] Hotkey "${entry.shortcut}" cannot be bound in Hyprland.`);
      continue;
    }
    const prev = combos.get(hypr.combo);
    if (prev) {
      // Two spellings of one combo ("Alt + Shift + D" / "Shift + Alt + D")
      // escape EE2's string comparison; the first one wins.
      if (prev.action.type !== "toggle-overlay" || entry.action.type !== "toggle-overlay") {
        logger?.write(
          `error [Shortcuts] It is not possible to use the same hotkey "${entry.shortcut}" for multiple actions.`,
        );
      }
      continue;
    }
    const bind: Bind = {
      id,
      shortcut: entry.shortcut,
      hypr,
      mode: "consume",
      keepModKeys: entry.keepModKeys,
      action: entry.action,
    };
    ids.add(id);
    combos.set(hypr.combo, bind);
    binds.push(bind);
  }

  // Escape closes a visible panel (EE2 handled it inside the focused
  // overlay window; here the game keeps the keyboard).
  const esc = hotkeyToHyprland("Escape")!;
  if (!combos.has(esc.combo)) {
    const bind: Bind = { id: "close-panel", shortcut: "Escape", hypr: esc, mode: "panel", action: { type: "close-panel" } };
    combos.set(esc.combo, bind);
    binds.push(bind);
  }

  if (opts.gameCopyBind) {
    const shortcut = copyItemShortcut(opts.showModsKey);
    const hypr = hotkeyToHyprland(shortcut);
    if (hypr && !combos.has(hypr.combo)) {
      const bind: Bind = { id: "game-copy", shortcut, hypr, mode: "pass", action: { type: "game-copy" } };
      combos.set(hypr.combo, bind);
      binds.push(bind);
    }
  }
  return binds;
}

export function generateBindsLua(binds: Bind[], opts: { windowTitle: string }): string {
  const actions = binds
    .map((b) => {
      const flags = b.mode === "pass" ? ", pass = true" : b.mode === "panel" ? ", panel = true" : "";
      return `  [${luaString(b.hypr.combo)}] = { id = ${luaString(b.id)}${flags} },`;
    })
    .join("\n");
  return `-- OmaExiled runtime binds and rules, generated by the backend
-- (backend/src/binds.ts) and loaded with dofile() through Hyprland's /eval.
-- A Hyprland config reload drops all of it; the backend loads it again on
-- \`configreloaded\`. Never hl.unbind() these combos: that would also remove
-- the user's own binds on them.
local M = rawget(_G, "omaexiled")
if type(M) ~= "table" then
  M = { binds = {}, panel = false }
  _G.omaexiled = M
end
M.enabled = true
M.title = ${luaString(opts.windowTitle)}
M.class = ${luaString(GAME_CLASS)}
M.actions = {
${actions}
}

local function is_poe(w)
  return w ~= nil and (w.class == M.class or w.title == M.title)
end

-- Runs inside Hyprland's input path: no blocking calls. { ok = false }
-- passes the key to the focused window (auto_consuming). M.lease is renewed
-- by the backend every few seconds; an expired lease means it is gone.
local function handler(combo)
  return function()
    local a = M.enabled and (M.lease or 0) >= os.time() and M.actions[combo]
    if not a or (a.panel and not M.panel) or not is_poe(hl.get_active_window()) then
      return { ok = false }
    end
    hl.dispatch(hl.dsp.event("omaexiled:" .. a.id))
    if a.pass then
      return { ok = false }
    end
  end
end

-- Types one key chord into a window like a person would: Wine/Proton only
-- sees a modifier that was pressed as a key. The presses run in this one
-- call so a real key event (the user letting go of a hotkey modifier) can't
-- land between Ctrl and C; the releases follow after hold ms.
local MODIFIER_KEYS = { CTRL = "Control_L", SHIFT = "Shift_L", ALT = "Alt_L", SUPER = "Super_L" }
function M.chord(window, mods, key, hold)
  local list = {}
  for m in string.gmatch(mods, "%S+") do
    list[#list + 1] = m
  end
  local function send(n, k, state)
    hl.dispatch(hl.dsp.send_key_state({ mods = table.concat(list, " ", 1, n), key = k, state = state, window = window }))
  end
  for i = 1, #list do
    send(i, MODIFIER_KEYS[list[i]] or list[i], "down")
  end
  send(#list, key, "down")
  hl.timer(function()
    send(#list, key, "up")
    for i = #list, 1, -1 do
      send(i - 1, MODIFIER_KEYS[list[i]] or list[i], "up")
    end
  end, { timeout = hold, type = "oneshot" })
end

local errors = {}
for combo, a in pairs(M.actions) do
  local b = M.binds[combo]
  if b then
    b:set_enabled(true)
  else
    local ok, res = pcall(hl.bind, combo, handler(combo), {
      auto_consuming = true,
      dont_inhibit = true,
      description = "OmaExiled: " .. a.id,
    })
    if ok and res then
      M.binds[combo] = res
    else
      table.insert(errors, combo .. ": " .. tostring(res))
    end
  end
end
for combo, b in pairs(M.binds) do
  if not M.actions[combo] then
    b:set_enabled(false)
  end
end

if not M.rules then
  M.rules = {
    -- no fade-in for the overlay panel
    hl.layer_rule({ name = "omaexiled-no-anim", match = { namespace = ${luaString(`^${LAYER_NAMESPACE}$`)} }, no_anim = true }),
    hl.window_rule({
      name = "omaexiled-settings",
      match = { title = ${luaString(`^${SETTINGS_TITLE}$`)} },
      float = true,
      center = true,
      size = { 1100, 800 },
    }),
    hl.window_rule({
      name = "omaexiled-browser",
      match = { title = ${luaString(`^${BROWSER_TITLE}$`)} },
      float = true,
      center = true,
      size = { 1280, 860 },
    }),
  }
end

if #errors > 0 then
  return "bind errors: " .. table.concat(errors, "; ")
end
return "installed"
`;
}

interface HyprBindInfo {
  modmask: number;
  key: string;
  keycode: number;
  description: string;
  submap: string;
}

export class Binds {
  private current: Bind[] = [];
  private byId = new Map<string, Bind>();
  private installedLua = "";
  private leaseTimer?: ReturnType<typeof setInterval>;
  readonly file: string;

  constructor(
    private hypr: Hyprland,
    private logger: Logger,
    runtimeDir: string,
  ) {
    this.file = path.join(runtimeDir, "binds.lua");
  }

  get binds() {
    return this.current;
  }

  find(id: string) {
    return this.byId.get(id);
  }

  update(shortcuts: ShortcutAction[], opts: BindOptions) {
    this.current = planBinds(shortcuts, opts, this.logger);
    this.byId = new Map(this.current.map((b) => [b.id, b]));
    return generateBindsLua(this.current, opts);
  }

  // Writes binds.lua and loads it into Hyprland's Lua state. `force` after
  // a config reload (the Lua state is new even if the file is not).
  async install(lua: string, force = false) {
    if (!this.hypr.available) return false;
    if (!force && lua === this.installedLua) return true;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.file, lua);
      const reply = await this.hypr.repl(`return dofile(${luaString(this.file)})`);
      if (reply !== "installed") {
        this.logger.write(`error [Shortcuts] Hyprland: ${reply}`);
      }
      this.installedLua = lua;
    } catch (e) {
      this.logger.write(`error [Shortcuts] Failed to install Hyprland binds: ${(e as Error).message}`);
      return false;
    }
    await this.renewLease();
    await this.logConflicts();
    return true;
  }

  // Keeps the binds active while the backend runs (see the file comment).
  startLease(intervalMs = LEASE_RENEW) {
    this.stopLease();
    if (!this.hypr.available) return;
    this.leaseTimer = setInterval(() => this.renewLease(), intervalMs);
  }

  stopLease() {
    clearInterval(this.leaseTimer);
    this.leaseTimer = undefined;
  }

  async renewLease() {
    if (!this.hypr.available) return;
    try {
      await this.hypr.eval(`local M = rawget(_G, "omaexiled") if M then M.lease = os.time() + ${LEASE_SECONDS} end`);
    } catch {
      // Hyprland busy or reloading: the next tick (or install) renews
    }
  }

  // Replaces EE2's "already registered by another application": Hyprland
  // runs every matching bind, so a user bind on the same combo fires too.
  async logConflicts() {
    let all: HyprBindInfo[];
    try {
      all = await this.hypr.json<HyprBindInfo[]>("binds");
    } catch {
      return;
    }
    for (const b of this.current) {
      const other = all.find(
        (x) =>
          !x.submap &&
          x.modmask === b.hypr.modmask &&
          !x.description.startsWith("OmaExiled") &&
          (b.hypr.keycode
            ? x.keycode === b.hypr.keycode
            : x.key.toLowerCase() === b.hypr.key.toLowerCase()),
      );
      if (other) {
        this.logger.write(
          `warn [Shortcuts] Hotkey "${b.shortcut}" is also bound in Hyprland ("${other.description || "no description"}"); both run while Path of Exile 2 is focused.`,
        );
      }
    }
  }

  async setPanel(visible: boolean) {
    if (!this.hypr.available) return;
    try {
      await this.hypr.eval(`local M = rawget(_G, "omaexiled") if M then M.panel = ${visible} end`);
    } catch (e) {
      this.logger.write(`error [Shortcuts] ${(e as Error).message}`);
    }
  }

  // On shutdown: every bind passes its key through again.
  async disable() {
    this.stopLease();
    if (!this.hypr.available) return;
    try {
      await this.hypr.eval(
        `local M = rawget(_G, "omaexiled") if M then M.enabled = false M.panel = false M.lease = nil for _, b in pairs(M.binds) do b:set_enabled(false) end end`,
      );
    } catch {}
    this.installedLua = "";
  }
}
