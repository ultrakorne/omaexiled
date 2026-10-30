# 08 — Platform: Hyprland 0.56 (Lua) runtime control, layer-shell-qt, QtWebEngine host

Scope: everything the Bun backend and the Qt host need from the platform:
Hyprland IPC (binds, key injection, events, queries, layer rules, focus rules),
layer-shell-qt 6.8 and QtWebEngine 6.x on this machine, plus a verified qmake
`.pro`. All Hyprland facts are checked against the **v0.56.2 source** (tag
`v0.56.2`, commit `efb50993780079460b0cbed1363e2166a2de1d9f`, the build running
here). Line numbers below refer to that tag. Wiki text is quoted only where it
matches the source. Where the wiki (it tracks git `main`) and 0.56.2 differ,
this note says so.

Notation: `HL:` = `https://github.com/hyprwm/Hyprland/blob/v0.56.2/`,
`LSQ:` = `https://invent.kde.org/plasma/layer-shell-qt` (mirror
`github.com/KDE/layer-shell-qt`, tag `v6.8.1`), `QTW:` =
`qtbase v6.12.0 src/plugins/platforms/wayland/` (QtWaylandClient moved into
qtbase in 6.12).

---

## 0. TL;DR

* **What to install: nothing more.** `layer-shell-qt 6.8.1-1` was installed
  at 2026-10-30 20:01 (`/var/log/pacman.log`: `Running 'pacman -S --needed
  layer-shell-qt'`). Everything else the host and backend need is already
  installed and verified by building and running test programs (§9).
  CMake is **not** needed: qmake links LayerShellQt with
  `LIBS += -lLayerShellQtInterface`. Optional extras are listed in §9.
* **Runtime binds under Lua.** Use `hyprctl eval '<lua>'` (or the raw socket
  `/eval <lua>`). `hyprctl keyword` is refused under Lua (`"keyword can't work
  with non-legacy parsers. Use eval."`, HL:src/debug/HyprCtl.cpp:1159-1163).
  `hl.bind(keys, dispatcher|function, opts)` returns a handle with
  `:set_enabled(bool)`, `:is_enabled()`, `:remove()`/`:unbind()`.
  **Every config reload, including Omarchy's autoreload on file save, destroys
  the Lua state and clears all keybinds, runtime ones included**
  (HL:src/config/lua/ConfigManager.cpp:714-723). Re-install after the
  `configreloaded` socket2 event.
* **Don't use `hl.unbind(...)` or `handle:remove()` on our binds.** Both
  remove *every* bind with that key combo, including the user's
  (KeybindManager.cpp:197-219). Disable with `:set_enabled(false)` instead, or
  better, keep the binds installed and gate them inside a Lua callback with
  `auto_consuming = true` (return `{ ok = false }` to pass the key through when
  PoE2 is not active). §2.4.
* **Bind → backend without spawning a process.** Have the bind call
  `hl.dispatch(hl.dsp.event("omaexiled:price-check"))`. socket2 then delivers
  `custom>>omaexiled:price-check\n` (ConfigActions.cpp:1268-1271).
* **Key injection.** Use `hl.dsp.send_shortcut({ mods = "CTRL ALT", key = "C",
  window = "address:0x…" })`. When the backend dispatches it over IPC (not from
  inside a bind callback), Hyprland sends press and release in one go
  (`m_passPressed == -1`). Inside a bind callback it sends only the press and
  defers the release to the physical key release, which causes the "stuck key"
  bug that Omarchy works around with `send_key_state` down/up plus a timer.
  XWayland targets work (source walk-through in §3.3, plus the user's earlier
  in-game evidence). Typing arbitrary text: put it on the clipboard and send
  `CTRL+V`. **XWayland can read the Wayland clipboard only while an Xwayland
  surface has seat keyboard focus** (XWM.cpp:744-746).
* **Sockets.** Requests: `$XDG_RUNTIME_DIR/hypr/$HYPRLAND_INSTANCE_SIGNATURE/.socket.sock`,
  one request per connection, `j/` prefix for JSON. Events:
  `…/.socket2.sock`, lines `EVENT>>DATA\n`. Bun's `Bun.connect({ unix })` speaks
  both (verified, §4).
* **Overlay above fullscreen.** Yes. Surfaces on the overlay layer are always
  rendered and hit-tested above fullscreen windows (Renderer.cpp:1233-1242,
  InputManager.cpp:470, LayerSurface.cpp:330-331). Any overlay-layer surface on a
  monitor blocks direct scanout and tearing there (Monitor.cpp:1878-1880).
* **Keyboard focus.** Mapping a surface with `on_demand` (or `exclusive`)
  **steals keyboard focus at map time** unless the pointer is constrained
  (LayerSurface.cpp:190-205). Map with `none`, then switch to `on_demand`
  after the first frame: changing interactivity after map does not grab focus
  (LayerSurface.cpp:369-407). With `input:follow_mouse = 1` (Omarchy's value),
  hovering an `on_demand` surface gives it the keyboard and hovering the game
  gives it back (InputManager.cpp:700-740).
* **layer-shell-qt.** Call `LayerShellQt::Window::get(qwindow)` and set
  `scope`/`layer`/`screen` **before `show()`**. Margins, anchors, size,
  interactivity, exclusive zone and layer can change live, but **only take
  effect after the next `wl_surface.commit`**: call `QQuickWindow::update()`
  after changing them (verified, §6.4). `hide()` destroys the layer surface;
  `show()` creates a new one. Use QML/`QQuickWindow` + `WebEngineView`, not a
  `QWidget` `QWebEngineView` (DESIGN.md records that the widget variant maps
  as a normal toplevel).
* **QtWebEngine runtime is 6.11.2 (Chromium 140)** even though the `.so`
  files are named 6.12.0 and the package is `qt6-webengine 6.11.2-2`. UA:
  `QtWebEngine/6.11.2 Chrome/140.0.0.0`. It works against qt6-base 6.12.0
  (verified).

---

## 1. Environment evidence (this machine)

```
$ hyprctl version
Hyprland 0.56.2 built from branch v0.56.2 at commit efb50993780079460b0cbed1363e2166a2de1d9f clean
Tag: v0.56.2, commits: 7661
Hyprgraphics 0.5.1, Hyprutils 0.14.2, Hyprcursor 0.1.13, Hyprlang 0.6.8, Aquamarine 0.15.1

$ echo $HYPRLAND_INSTANCE_SIGNATURE $XDG_RUNTIME_DIR $WAYLAND_DISPLAY
efb50993780079460b0cbed1363e2166a2de1d9f_1793385648_766514262 /run/user/1000 wayland-1
$ ls -la /run/user/1000/hypr/$HYPRLAND_INSTANCE_SIGNATURE/
hyprland.lock  hyprland.log  .socket2.sock  .socket.sock

GPU: NVIDIA GA102 [GeForce RTX 3080]
env: QT_QPA_PLATFORM=wayland;xcb  QT_IM_MODULE=fcitx  QT_QPA_PLATFORMTHEME=gtk3
     __GLX_VENDOR_LIBRARY_NAME=nvidia  LIBVA_DRIVER_NAME=nvidia  NVD_BACKEND=direct

Monitor DP-1: 2560x1440@144, scale 1, transform 0, at 0,0, reserved [0,26,0,0]
             (26 px = omarchy-bar exclusive zone, top)

$ hyprctl getoption input:follow_mouse -j      → {"int": 1, "set": true}
$ hyprctl getoption misc:layers_hog_keyboard_focus -j → {"bool": true, "set": false}
$ hyprctl getoption input:mouse_refocus -j     → {"bool": true, "set": false}
$ hyprctl getoption misc:disable_autoreload -j → {"bool": false, "set": false}   # autoreload ON
```

Config: Hyprland Lua. User entry `~/.config/hypr/hyprland.lua` does
`dofile(($OMARCHY_PATH or "/usr/share/omarchy").."/default/hypr/bootstrap.lua")`,
`require("default.hypr.omarchy")`, then `hypr.monitors|input|bindings|looknfeel|autostart`.
The API reference ships as a stub: **`/usr/share/hypr/stubs/hl.meta.lua`**
(autogenerated from the 0.56.2 source; 1777 lines). The reference config is
`/usr/share/hypr/hyprland.lua`. Omarchy helpers: `/usr/share/omarchy/default/hypr/helpers.lua`
(`o.bind(keys, description, cmd_or_dispatcher, opts)` → `hl.bind(keys, hl.dsp.exec_cmd(cmd), opts)`).

Existing user state relevant to us:

* `~/.config/hypr/bindings.lua:9`: `o.bind("CTRL + ALT + D", "PoE2 price check", "/home/ultra/Developer/poe_price_checker/bin/poe-pricecheck.sh")`.
  This is the user's older project. If OmaExiled keeps EE2's defaults (`Ctrl+D`, `Alt+D`) there is no
  clash. That script's `hyprctl dispatch sendshortcut "CTRL, C, class:^${cls}$"` (line 31) uses the
  **legacy** dispatcher syntax and **fails under the Lua config**: `dispatch` is wrapped as
  `return hl.dispatch(<arg>)` (HyprCtl.cpp:1131-1137), so legacy arguments are a Lua syntax error.
* `~/.config/hypr/hyprland.lua:43-51`: a window rule for class `exiled-exchange-2` (the old Electron
  EE2). Not relevant to OmaExiled.
* Omarchy applies `opacity = "0.985 0.96"` to every window tagged `default-opacity`
  (`/usr/share/omarchy/default/hypr/windows.lua`), which includes our settings window unless it opts out
  (§2.9).
* Omarchy layer animations (`/usr/share/omarchy/default/hypr/looknfeel.lua:83-87`): `layersIn` speed 4
  (≈400 ms) style `fade`; `layersOut` 1.5; `fadeLayersIn` 1.79; `fadeLayersOut` 1.39. Without a
  `no_anim` layer rule our panel fades in over hundreds of ms (§2.8).

PoE2 window facts (user's earlier project `~/Developer/poe_price_checker/SETUP.md`, Hyprland 0.55.2,
same machine): class **`steam_app_2694490`**, title **`Path of Exile 2`**, **XWayland** (Steam/Proton).
In-game *Windowed* gives `fullscreen=0` and copy plus overlay clicks **worked**. *Windowed
Fullscreen/Fullscreen* gives Hyprland `fullscreen=2` and "wedges XWayland input" there: "Ctrl+C copies
nothing, overlay clicks fall through". Software cursors did not help. **ydotool desyncs modifiers**;
compositor `sendshortcut` worked. EE2's own default `windowTitle` config is `"Path of Exile 2"`.
OmaExiled's `DESIGN.md` reports these results measured with `tools/fake-poe` (an xcb window with that
title and class) under 0.56.2: overlay above fullscreen XWayland ✔; `send_key_state` Ctrl+Alt+C
received ✔; real-game behaviour still to be checked in game.

---

## 2. Hyprland 0.56.2 Lua: runtime control

### 2.1 `hyprctl` commands under the Lua config manager (source-verified)

| Command | Behaviour in 0.56.2 | Source |
|---|---|---|
| `hyprctl eval '<code>'` | Runs `<code>` in **the same Lua state as the config** (`m_lua`). It is first compiled as `return <code>;`, and if that fails, as-is. Reply: `ok`, or `error: …` lines (errors and warnings collected during the call). Return values are **not** printed. Timeout **250 ms** (`LUA_TIMEOUT_EVAL_MS`). | HyprCtl.cpp:1110-1123, ConfigManager.cpp:880-940, ConfigManager.hpp:113 |
| `hyprctl repl '<code>'` | Same, but prints the returned values (tab-separated) and `print()` output. Good for read-only queries. | HyprCtl.cpp:2043, ConfigManager.cpp:600-625, 905-925 |
| `hyprctl dispatch '<expr>'` | Shorthand for `eval "return hl.dispatch(<expr>)"`. Legacy `dispatcher args` strings fail; the reply then has an extra note `→ Note: dispatch in lua is a shorthand for hl.dispatch(...)`. | HyprCtl.cpp:1125-1137 |
| `hyprctl keyword …` | **Refused**: `keyword can't work with non-legacy parsers. Use eval.` | HyprCtl.cpp:1159-1163 |
| `hyprctl getoption input:follow_mouse -j` | Works under Lua (colon path). | verified |
| `hyprctl binds -j` | Lists binds incl. `non_consuming`, `auto_consuming`, `description`, `dispatcher` (`"__lua"` for Lua callbacks/dispatchers), `arg` (Lua registry ref). | verified output §10 |

Verified (read-only) outputs:

```
$ hyprctl repl 'return hl.version()'            → 0.56.2
$ hyprctl eval 'return hl.version()'            → ok
$ hyprctl repl 'local p = hl.get_cursor_pos(); return p.x, p.y'
2264.1824722275169	518.44246663714148                  # floats, global logical coords
$ hyprctl repl 'local w = hl.get_active_window(); return w and w.address, w and w.class, w and w.xwayland'
0x55755c04e150	com.mitchellh.ghostty	false            # Lua window.address HAS the 0x prefix
$ hyprctl repl 'local m = hl.get_monitor_at_cursor(); return m.name, m.x, m.y, m.width, m.height, m.scale, m.transform'
DP-1	0	0	2560	1440	1.0	0                        # width/height = PIXEL size (LuaMonitor.cpp:91-94)
```

**The Lua state is persistent between `eval`s.** Globals set by one `eval` (e.g. `_G.omaexiled = {…}`)
are visible to the next `eval` and to bind callbacks, **until the next config reload**.
`CConfigManager::reload()` (ConfigManager.cpp:634-760) does, in order:
`m_eventHandler->clearEvents()`, unrefs every `"__lua"` keybind and
**`g_pKeybindManager->clearKeybinds()` (line 719)**, then **`reinitLuaState()` (line 723: `lua_close` +
`luaL_newstate`)**, re-runs the config, and finally posts **`configreloaded>>`** on socket2 (line 854).
Window and layer rules are cleared too (`clearAllRules()`, `m_luaLayerRules.clear()`). Reloads happen
on `hyprctl reload`, and automatically when any tracked config file is saved (line 417-418,
`misc:disable_autoreload = false` here). **So the backend must re-apply all runtime binds and rules
after every `configreloaded` event, and once at startup.**

Lua callback time limits (ConfigManager.hpp:108-114): keybind callback 100 ms, `hl.dispatch` 100 ms,
event callback 50 ms, timer callback 50 ms, eval 250 ms, config reload 1500 ms. The wiki warning
applies: "Keybind handlers must not block… Avoid `io.popen`, network I/O, clipboard tools (`wl-paste`,
`xclip`), sleeps… A hung or slow call freezes input and the entire desktop until it returns."

### 2.2 Raw request socket (Bun talks directly, no `hyprctl` spawn)

* Path: `${XDG_RUNTIME_DIR}/hypr/${HYPRLAND_INSTANCE_SIGNATURE}/.socket.sock` (verified).
* Protocol: connect, write **one** request, read until EOF (Hyprland writes the reply and closes).
  The wiki warns: "Hyprland evaluates connections to this socket completely synchronously… any unclosed
  connections *will cause Hyprland to freeze* until the five-second timeout is reached." Always
  open, write and close promptly.
* Request format: `[flags]/command args`. Flag chars before the first `/`: `j` = JSON, `r` = refresh,
  `a` = all, `c` = sysinfo config. **Flag parsing stops at the first space**, so slashes inside
  arguments (paths, Lua) are safe (HyprCtl.cpp:2062-2097). Use a leading `/` for commands without
  flags (e.g. `/eval …`, `/dispatch …`).
* Batch: `[[BATCH]]j/clients;j/cursorpos` splits on `;` outside `[]`. Replies are joined with
  **`"\n\n\n"`** (HyprCtl.cpp:1308-1333). **Never batch `eval`/`dispatch`**: Lua code containing `;` gets
  split.
* Read quirk (HyprCtl.cpp ~2272-2281): the server `read()`s 1023-byte chunks and **stops at the first
  chunk shorter than 1023 bytes**. Send the request in **one `write()`**. A request whose length is an
  exact multiple of 1023 makes the server block for more data (until the 5 s timeout), so pad with a
  trailing space. For large Lua, write it to a file and send `/eval dofile("/run/user/1000/omaexiled/hypr.lua")`.
* JSON replies may start with a newline (e.g. `j/cursorpos` → `"\n{\n    \"x\": …"`). `JSON.parse` handles it.

Verified with Bun 1.4.3 (scratch script, read-only):

```ts
const dir = `${process.env.XDG_RUNTIME_DIR}/hypr/${process.env.HYPRLAND_INSTANCE_SIGNATURE}`;
function hypr(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    Bun.connect({ unix: `${dir}/.socket.sock`, socket: {
      open(s) { s.write(cmd); s.flush(); },
      data(_s, d) { buf += new TextDecoder().decode(d); },
      close() { resolve(buf); },
      error(_s, e) { reject(e); },
    }}).catch(reject);
  });
}
// await hypr("j/cursorpos")          → "\n{\n    \"x\": 1004,\n    \"y\": 1258\n}\n"
// await hypr("cursorpos")            → "1004, 1258"
// await hypr("j/getoption input:follow_mouse") → {"option": "input:follow_mouse", "int": 1, "set": true }
// await hypr("[[BATCH]]j/cursorpos;j/activeworkspace") → two JSON docs separated by "\n\n\n"
// await hypr("/repl return 1+1")     → "2"
// await hypr("/eval return 1+1")     → "ok"
```

Run Hyprland requests one at a time per purpose (they are cheap: ≈1 ms). Serialize `eval`s that
depend on each other. Treat any reply other than `ok` from `/eval` or `/dispatch` as an error string.

### 2.3 `hl.bind`: exact 0.56.2 semantics

Signature (stub `hl.meta.lua:822`): `hl.bind(keys: string, dispatcher: HL.Dispatcher|function, opts?: HL.BindOptions): HL.Keybind`

**Key string** (LuaBindingsToplevel.cpp:30-130):
* Split on `+`, each token trimmed. **Modifiers must come first** ("Modifiers must come first in the list").
* Modifier tokens are **case-sensitive upper-case**: `SHIFT`, `CAPS`, `CTRL`|`CONTROL`, `ALT`|`MOD1`,
  `MOD2`, `MOD3`, `SUPER`|`WIN`|`LOGO`|`MOD4`|`META`, `MOD5`. (`ctrl` would be parsed as a keysym and fail.)
* Key token: xkb keysym name, looked up **case-insensitively** (`xkb_keysym_from_name(…, XKB_KEYSYM_CASE_INSENSITIVE)`),
  so `D`/`d` both work. `Enter` is rejected with hint `did you mean "Return"?`.
* `code:NN` = raw xkb keycode (evdev code + 8; e.g. `code:40` = D on US layout, `code:28` = T).
* Specials: `mouse_down`, `mouse_up`, `mouse_left`, `mouse_right` (wheel), `mouse:272` (LMB) etc., `switch:…`, `catchall` (submaps only).
* Several non-modifier keys = multi-key bind (`"Ctrl_L + Ctrl_R"`).
* Matching (KeybindManager.cpp:705-726) compares the pressed keysym with the bind key in both
  case-sensitive and lower-cased form, so `CTRL + D` matches whether or not Shift changes the keysym. It
  also requires `modmask == bind modmask` exactly unless `ignore_mods`.

**Options** (LuaBindingsToplevel.cpp:186-237; anything else is ignored):

| opt | effect (0.56.2 source) |
|---|---|
| `repeating` | repeat while held (uses keyboard repeat rate/delay). Incompatible with `release`/`long_press`. |
| `locked` | also works while session locked. |
| `release` | fire on key release. On press the event is **consumed** unless `non_consuming`/`auto_consuming` (line 728-733). |
| `non_consuming` | always pass the key (press **and** release) to the focused surface as well. |
| `auto_consuming` | pass the key through **iff the dispatcher/callback result is not success** (`return { ok = false }`). The release is always passed (line 747-751, 835). |
| `transparent` | cannot be shadowed by other binds. |
| `ignore_mods` | match regardless of modifiers. |
| `dont_inhibit` | still fires while a client holds a keyboard-shortcuts-inhibitor (line 643). **Recommended for our binds**: fullscreen games/Xwayland grabs can inhibit shortcuts. |
| `long_press` | fire after repeat-delay hold. |
| `submap_universal` | active in every submap. |
| `click` / `drag` | release-type mouse binds by drag threshold. |
| `description` / `desc` | shown in `hyprctl binds` and Omarchy's keybinding menu. |
| `device = { inclusive = bool, list = {…} }` | per-device binds. |
| `allow_input_capture` | process while input-capture portal is active. |

`hl.bind` also accepts `mouse = true` for drag/resize binds (wiki "Mouse binds"); this is not needed here.

**Return value / result semantics.** A Lua *function* bind runs as dispatcher `"__lua"`
(LuaBindingsRegistration.cpp:63-82). Its return value is converted by `dispatchResultFromLua`
(lines 30-52): non-table → default `{passEvent=false, success=true}` (SharedDefs.hpp:52-56). A table may
carry `ok` (bool → `success`), `error` (string) and **`pass_event`** (bool). With `auto_consuming`,
`{ ok = false }` passes the key. (`pass_event = true` also passes the *press*, but without
`auto_consuming`/`non_consuming` the *release* is still swallowed, which leaves a stuck key in the
client, so use `auto_consuming`.)

**Executing a shell command.** `hl.dsp.exec_cmd("cmd args")` takes a shell command string (Omarchy
uses `pkill hyprpicker || hyprpicker -a`). An optional 2nd arg is an exec-rules table, e.g.
`hl.dsp.exec_cmd("foot", { float = true })`. `hl.dsp.exec_raw("cmd")` spawns without rules.
In a function bind it must be wrapped: `hl.dispatch(hl.dsp.exec_cmd("…"))`. A bare `hl.dsp.*()` call
does nothing (wiki "Dispatchers").

**Handles** (`HL.Keybind`, LuaKeybind.cpp:104-170): methods `set_enabled(bool)`, `is_enabled()`,
`remove()` == `unbind()`. Fields `enabled, display_key, key, keycode, modmask, release, repeating,
non_consuming, auto_consuming, transparent, ignore_mods, long_press, dont_inhibit, click, drag,
submap, submap_universal, mouse, handler, arg, description, has_description, devices, device_inclusive,
allow_input_capture`.

**Removal pitfalls (important):**
* `handle:remove()`/`:unbind()` → `removeKeybind(modmask, {key, keycode, catchAll})`, which erases
  **every** bind with the same modmask+key+keycode (KeybindManager.cpp:197-202, LuaKeybind.cpp:68-87).
* `hl.unbind("CTRL + D")` → removes every bind whose display string matches after stripping spaces and
  lower-casing (KeybindManager.cpp:204-219). So `"CTRL + D"` == `"ctrl+d"`. (The wiki's "case-sensitive"
  warning is stricter than 0.56.2.) `hl.unbind("all")` clears **all** binds.
* DESIGN.md confirms: "`hl.unbind` removes **every** bind on that combo".
* ⇒ For our own binds use `:set_enabled(false)`. Disabled binds stay registered (harmless, a few bytes).
  The next config reload purges them anyway.

### 2.4 Recommended runtime bind pattern (game-gated, reload-proof, no process spawn)

Two viable designs:

**A. Static, self-gating binds (recommended).** Install once per Lua state (startup and every
`configreloaded`). Each bind is a Lua function that checks the active window and either signals the
backend or passes the key through. No focus-tracking race, no install/remove churn, and
non-PoE2 apps get the key unchanged.

**B. Install/remove on focus change** (the current DESIGN.md "Hotkeys" text). The backend watches
`activewindowv2` and enables or disables binds. Caveats: use `set_enabled` rather than
`hl.unbind` (collateral damage, §2.3). Debounce transient focus events: layer-surface focus changes
emit `activewindow>>,` then the game again (§8.2). There is a race where the first key press after
alt-tabbing back arrives before the backend has re-enabled the binds.

Example bootstrap for A, written by the backend to `$XDG_RUNTIME_DIR/omaexiled/hypr.lua` and loaded
with `/eval dofile("…/hypr.lua")`:

```lua
-- OmaExiled runtime Hyprland integration (generated; lost on every config reload)
local GEN = "{{generation-hash}}"            -- hash of the bind set; skip if unchanged
local prev = rawget(_G, "omaexiled")
if prev and prev.gen == GEN then return "unchanged" end
if prev then for _, b in ipairs(prev.binds) do b:set_enabled(false) end end   -- never :remove()

local M = { gen = GEN, binds = {} }
_G.omaexiled = M

local function is_poe(w)
  if not w then return false end
  return w.title == "Path of Exile 2" or w.class == "steam_app_2694490"   -- from config
end
M.is_poe = is_poe

-- action = string sent to the backend via socket2 "custom>>omaexiled:<action>"
local function bind(keys, action, extra)
  local opts = { auto_consuming = true, dont_inhibit = true, description = "OmaExiled: " .. action }
  for k, v in pairs(extra or {}) do opts[k] = v end
  local b = hl.bind(keys, function()
    if not is_poe(hl.get_active_window()) then return { ok = false } end   -- pass key to app
    hl.dispatch(hl.dsp.event("omaexiled:" .. action))                      -- consumed
  end, opts)
  table.insert(M.binds, b)
end

bind("CTRL + D", "price-check")
bind("ALT + D",  "item-check")
bind("F5",       "chat:0")
bind("F9",       "chat:1")
-- release-triggered example:   bind("CTRL + D", "price-check-release", { release = true })
-- repeating example:           bind("CTRL + mouse_down", "stash-scroll-next", { repeating = false })
-- pass-through observe example (game ALSO gets the key): use non_consuming = true instead of auto_consuming

hl.layer_rule({ name = "omaexiled-noanim", match = { namespace = "^omaexiled" }, no_anim = true })
return "installed"
```

Notes:
* `hl.dsp.event(data)` posts socket2 `custom>>data` (ConfigActions.cpp:1268-1271). The data is
  truncated to 1024 chars and newlines become spaces (EventManager.cpp:126-131).
* Use `return` values with `/repl dofile(…)` if the backend wants the `"unchanged"`/`"installed"`
  string back (`/eval` only returns `ok`).
* The class/title matcher and the key strings must be generated from the user's settings. Map EE2 key
  names (`ipc/KeyToCode.ts`) to xkb names: `Enter→Return`, `Space→space`, `Backspace→BackSpace`,
  `Tab→Tab`, `Escape→Escape`, `PageUp→Prior`, `PageDown→Next`, `End→End`, `Home→Home`,
  `ArrowLeft/Up/Right/Down→Left/Up/Right/Down`, `Insert→Insert`, `Delete→Delete`, `0-9→0-9`,
  `A-Z→A-Z`, `Numpad0-9→KP_0..KP_9`, `NumpadMultiply→KP_Multiply`, `NumpadAdd→KP_Add`,
  `NumpadSubtract→KP_Subtract`, `NumpadDecimal→KP_Decimal`, `NumpadDivide→KP_Divide`, `F1-F24→F1-F24`,
  `Semicolon→semicolon`, `Equal→equal`, `Comma→comma`, `Minus→minus`, `Period→period`,
  `Slash→slash`, `Backquote→grave`, `BracketLeft→bracketleft`, `Backslash→backslash`,
  `BracketRight→bracketright`, `Quote→apostrophe`, `CapsLock→Caps_Lock`. Modifiers `Ctrl→CTRL`,
  `Shift→SHIFT`, `Alt→ALT`. Keysym names are layout-dependent (they bind to whatever key produces
  that keysym). Use `code:NN` for layout-independent binds.
* Stash scroll (EE2 Ctrl+wheel outside the stash area → ArrowLeft/Right): bind `"CTRL + mouse_down"` /
  `"CTRL + mouse_up"` with `auto_consuming`. In the callback, test `hl.get_cursor_pos()` against the game
  window box (`w.at`, `w.size`) and return `{ ok = false }` to let the wheel through. Otherwise
  `hl.dispatch(hl.dsp.send_shortcut({ mods = "", key = "Right" }))`. (Inside a bind callback,
  `send_shortcut` sends only "down" and defers "up". For wheel binds there is no key release, so prefer
  `send_key_state` down then up in the same callback, see §3.2.)
* The Lua state is shared with the user's config. Namespace everything under `_G.omaexiled`.

**Fallback signalling** if `hl.dsp.event` is not wanted: `hl.dsp.exec_cmd("omaexiled ctl price-check")`
(DESIGN.md). That spawns a shell plus client per keypress (a few ms) and needs the client to reach the
backend (HTTP/unix socket).

### 2.5 Other Lua APIs available at runtime (stub-verified)

`hl.get_active_window()`, `hl.get_window(selector)`, `hl.get_windows({class=,title=,…})`,
`hl.get_cursor_pos()`, `hl.get_monitor_at_cursor()`, `hl.get_monitor(sel)`, `hl.get_monitors()`,
`hl.get_layers({namespace=,monitor=})`, `hl.get_active_workspace()`, `hl.is_key_down("Control_L"|keycode)`,
`hl.timer(fn, { timeout = ms, type = "oneshot"|"repeat" })`, `hl.on(event, fn)` (events list
`hl.meta.lua:5-36`: `window.active`, `window.open`, `window.close`, `window.fullscreen`,
`window.title`, `layer.opened`, `layer.closed`, `workspace.active`, `monitor.added/removed/focused`,
`config.reloaded`, `input.keyboard.key`, …). The wiki also lists `config.unload`, `window.bell`,
`window.minimize`, `window.update_state`, `workspace.created_early`, but **they are not in 0.56.2**.
`hl.notification.create({ text, timeout, icon })`, `hl.window_rule{…}`, `hl.layer_rule{…}`,
`hl.dsp.cursor.move(…)`, `hl.dsp.focus({ window = sel })`.
`HL.Window` fields: `address` ("0x…"), `class`, `title`, `initial_class`, `initial_title`, `xwayland`,
`fullscreen` (0 none, 1 maximized, 2 fullscreen, 3 both), `fullscreen_client`, `floating`, `at`,
`size`, `monitor` (HL.Monitor), `workspace`, `pid`, `stable_id`, `mapped`, `visible`, `accepts_input`,
`content_type`, `tags`.

---

## 3. Sending keys to the game

### 3.1 Syntax (0.56.2)

```lua
hl.dsp.send_shortcut({ mods = "CTRL ALT", key = "C", window = "address:0x55755c04e150" })
hl.dsp.send_key_state({ mods = "CTRL", key = "V", state = "down" | "up" | "repeat", window = "class:^steam_app_2694490$" })
hl.dsp.pass({ window = sel })        -- re-sends the CURRENT bind's key to a window (not needed here)
```
(LuaBindingsDispatchers.cpp:402-479; registration lines 1403-1405.)

* `mods`: free text, upper-cased, **substring** matched: contains `SHIFT`, `CAPS`, `CTRL`/`CONTROL`,
  `ALT`/`MOD1`, `MOD2`, `MOD3`, `SUPER`/`WIN`/`LOGO`/`MOD4`/`META`, `MOD5` (KeybindManager.cpp:221-242).
  `"CTRL ALT"`, `"CTRL+ALT"`, `"ctrl,alt"` are equivalent; `""` = no modifiers.
* `key` resolution (`resolveKeycode`, lines 353-398): a number > 9 is a raw keycode; `code:NN`; `mouse:NNN`
  (≥ 272) = mouse button (DESIGN.md verified `mouse:272` click). Otherwise
  `xkb_keysym_from_name(key, CASE_INSENSITIVE)` is looked up in the **current layout group with no
  modifiers**, cached per keyboard+name. So `"C"` → keycode of the `c` key. Names: `Return`, `KP_Enter`,
  `BackSpace`, `Delete`, `Home`, `End`, `Escape`, `Tab`, `Up`, `Down`, `Left`, `Right`, `A`, `V`, `F`,
  `C`. **Characters that need Shift or AltGr cannot be produced by name alone** (add `mods="SHIFT"`
  yourself). The cache may go stale if the layout switches at runtime (`m_keyToCodeCache` key = keyboard
  pointer + name).
* `window`: selector string or window object; omitted = active window. Selectors (wiki
  `configuring/selectors.md`): exact `address:0x…`, `pid:…`, `stableid:…`; regex (RE2) `class:…`,
  `initialclass:…`, `title:…`, `initialtitle:…`, `tag:…`; `activewindow`, `floating`, `tiled`.
  Window not found → warning `send_shortcut: window not found` (reply ≠ `ok`).

From the backend:
```
/dispatch hl.dsp.send_shortcut({ mods = "CTRL ALT", key = "C", window = "address:0x55755c04e150" })
```
(socket reply `ok` on success). From a shell:
`hyprctl dispatch 'hl.dsp.send_shortcut({ mods = "CTRL ALT", key = "C", window = "class:^steam_app_2694490$" })'`.

### 3.2 Press/release semantics: why Omarchy splits down/up

`Actions::pass(modMask, key, window)` (ConfigActions.cpp:1530-1599) sends:
`sendKeyboardMods(modMask)` → key **press and/or release depending on `m_passPressed`** →
`sendKeyboardMods(0)`.

* `m_passPressed` is set to `1`/`0` (pressed/released) **only while a keybind is being processed**
  and reset to `-1` afterwards (KeybindManager.cpp:804, 814). Default is `-1` = "dynamic
  (press+release)" (ConfigActions.hpp:114).
* ⇒ **From IPC (`/dispatch`, `/eval`) → press + release in one call.** This is the clean path for the
  backend.
* ⇒ **From inside a bind callback on key press → only the press is sent**, and
  `m_currentKeybind->releasePending = true` (LuaBindingsDispatchers.cpp:418). On the physical key
  release the bind is processed again as a "special dispatcher", so the Lua callback **runs a second
  time** with `m_passPressed = 0` and `send_shortcut` then sends the release. If the callback logic
  differs on the second run, the release is never sent and the key sticks. That is the
  bug referenced by Omarchy (`/usr/share/omarchy/default/hypr/bindings/clipboard.lua:1-16`, GitHub
  discussion hyprwm/Hyprland#14099). Omarchy uses
  `send_key_state(down)` then `hl.timer(…up…, { timeout = 50, type = "oneshot" })`.
  `send_key_state` forces `m_passPressed` to 1 or 0 for that call (ConfigActions.cpp:1601-1617), so it
  is deterministic in any context. `state = "repeat"` sends down twice.
* After sending, Hyprland always sends `modifiers = 0` to that client, even if the user still holds
  physical modifiers (e.g. Ctrl from a Ctrl+D hotkey). The real modifier state is re-sent on the next
  physical modifier change. This is harmless for PoE2 copy/paste, but don't rely on the game seeing
  the held modifier after an injection.

Recommendation: the bind only signals (`hl.dsp.event`); the backend then dispatches
`send_shortcut` over the socket (press+release atomic). If the backend ever injects from inside a
bind callback, use the Omarchy `send_key_state` down/up + `hl.timer` pattern.

### 3.3 XWayland targets (PoE2 under Proton)

From `Actions::pass(modMask, key, window)` (ConfigActions.cpp:1530-1599):
1. `setKeyboardFocus(window surface)` (seat-level, not window focus).
2. If target is X11 and the focused *window* is Wayland → `activateSurface(target, true)` (X11 activate).
3. If target is X11 **and the focused window is also X11** (normal case: game focused) → `window = nullptr`
   ("xwl -> xwl, send to current"). The keys go to the current seat keyboard focus, which step 1 just set
   to the game surface, and **focus is not restored afterwards**.
4. Send mods, key, mods(0). If `window` is still set (Wayland-focused case), for X11 targets reset seat
   keyboard focus state and restore the previously focused surface.

Consequences:
* Game focused (the gated case) → keys reach the game. ✔
* Our overlay panel holds keyboard focus (on_demand + hover) while the game is still the focused
  *window* → step 3 applies: keys go to the game surface and the seat focus stays on the game. On the
  next pointer motion over the panel Hyprland re-focuses the panel (FocusState.cpp:223-226 checks seat
  focus).
* Settings window (Wayland) focused → step 2/4 path: activation dance, then focus is restored **right
  after** sending. A paste (`Ctrl+V`) in that state will usually **fail**, because by the time Wine asks
  for the clipboard, Xwayland no longer has keyboard focus (next bullet). Only inject chat macros while
  PoE2 is the active window.
* **Clipboard bridge requires Xwayland focus.** `[xwm] Ignoring clipboard access: xwayland not in focus`:
  X11 selection requests are refused unless `seat.keyboardFocusResource` belongs to the Xwayland client
  (XWM.cpp:744-746). Wayland→X11 ownership is taken immediately when the Wayland selection changes
  (`onSelection`, XWM.cpp:1447-1471), and re-announced on Xwayland focus (`onKeyboardFocus`,
  XWM.cpp:1473-1485). So `wl-copy` text is pasteable into the game as long as the game has keyboard
  focus when it processes Ctrl+V.
* The game→Wayland direction (Ctrl+Alt+C in game, then `wl-paste`) worked in the user's earlier project
  (0.55.2) and in DESIGN.md's fake-poe test (visible to `wl-paste` within 400 ms).
* Risk: in-game *Windowed Fullscreen/Fullscreen* (Hyprland `fullscreen=2`) broke both copy and
  overlay clicks in the user's 0.55.2 tests, with an XWayland *window* overlay. With a layer-shell
  overlay the rendering part is solved (§7). Whether key injection works in `fullscreen=2` is
  **unverified**; check in game. `dont_inhibit = true` on binds covers the shortcuts-inhibitor case.

### 3.4 Typing text (chat macros, stash search)

Use EE2's own approach (`main/src/shortcuts/text-box.ts`): write text to the clipboard, then send keys.
Translated to Hyprland key names (all via `send_shortcut` from the backend, sequentially, each a
separate `/dispatch` or one `/eval` with several `hl.dispatch` calls):

| EE2 (`uIOhook.keyTap`) | Hyprland `send_shortcut` |
|---|---|
| `Key.Enter` | `{ mods = "", key = "Return" }` |
| `Key.Enter, [Ctrl]` | `{ mods = "CTRL", key = "Return" }` |
| `Key.Home` | `{ mods = "", key = "Home" }` |
| `Key.Delete` | `{ mods = "", key = "Delete" }` |
| `Key.A, [Ctrl]` | `{ mods = "CTRL", key = "A" }` |
| `Key.V, [Ctrl]` | `{ mods = "CTRL", key = "V" }` |
| `Key.ArrowUp` | `{ mods = "", key = "Up" }` |
| `Key.Escape` | `{ mods = "", key = "Escape" }` |
| `Key.F, [Ctrl]` | `{ mods = "CTRL", key = "F" }` |
| `Key.ArrowRight/Left` | `{ mods = "", key = "Right" / "Left" }` |
| item copy | `{ mods = "CTRL ALT", key = "C" }` (or `"CTRL"` for basic text) |

Sequencing: Wine processes X events asynchronously. One `/eval` containing several `hl.dispatch(...)`
calls sends them back-to-back in a single compositor turn, so ordering is preserved, but the game
may need time to open chat after `Return` before `Ctrl+V`. If pastes go missing, split into separate
dispatches with small delays (e.g. 20-50 ms) from the backend. Clipboard handling (save → `wl-copy` →
restore) belongs to the backend (EE2 `HostClipboard.restoreShortly`).

Alternatives considered and **rejected**: `wtype` (virtual-keyboard protocol uploads its own keymap and
merges with held physical modifiers, as Omarchy's comment in `bindings/clipboard.lua:3-5` notes);
`ydotool` (uinput; desyncs modifiers, user's SETUP.md); per-character `send_shortcut` (no Shift/AltGr
resolution, layout-fragile); `xdotool` (Wine ignores XSendEvent, EE2 LINUX_OVERLAY_REPORT.md).

---

## 4. Event socket (socket2)

* Path: `${XDG_RUNTIME_DIR}/hypr/${HYPRLAND_INSTANCE_SIGNATURE}/.socket2.sock` (verified).
* Framing: `EVENT>>DATA\n`. DATA is truncated to **1024 chars**, newlines inside DATA become spaces
  (EventManager.cpp:126-131). TCP-like stream: buffer and split on `\n` yourself (chunks can split lines).
* Back-pressure: if a client has **64** unread events queued, Hyprland **drops the connection**
  (EventManager.cpp:163-178). Read continuously and reconnect on close (then re-query state).
* Window addresses in events are **hex without `0x`** (`std::format("{:x}", ptr)`). `hyprctl clients -j`
  and Lua `w.address` use `0x…`. Normalize: `"0x" + data`.

Verified live capture (Bun listener while a test layer surface mapped and unmapped):
```
[364ms] openlayer>>omaexiled-test
[2981ms] closelayer>>omaexiled-test
```

Events we need (formats checked in 0.56.2 source):

| Event line | Data | Source |
|---|---|---|
| `activewindow>>CLASS,TITLE` | split on the **first** comma (title may contain commas). Empty focus → `activewindow>>,` | FocusState.cpp:139,209,243 |
| `activewindowv2>>ADDR` | hex, no 0x; empty string when nothing focused | FocusState.cpp:140,210,244 |
| (also re-emitted on title/class change of the focused window) | | Window.cpp:1457-1458, 1474-1475 |
| `openwindow>>ADDR,WORKSPACENAME,CLASS,TITLE` | split into max 4 fields | Window.cpp:2369 |
| `closewindow>>ADDR` | | Window.cpp:2574 |
| `windowtitlev2>>ADDR,TITLE` | | Window.cpp:1453 |
| `fullscreen>>0|1` | **no window address**: query `activewindow`/`clients` after it. "A fullscreen event is not guaranteed to fire on/off once in succession" (wiki) | FullscreenController.cpp:485 |
| `workspace>>NAME`, `workspacev2>>ID,NAME` | | Monitor.cpp:1505-1506 |
| `focusedmon>>MON,WSNAME`, `focusedmonv2>>MON,WSID` | | FocusState.cpp:287-288 |
| `movewindowv2>>ADDR,WSID,WSNAME` | | Window.cpp:580 |
| `openlayer>>NAMESPACE`, `closelayer>>NAMESPACE` | on map/unmap of a layer surface | LayerSurface.cpp:218,227 |
| `monitoradded>>NAME` / `monitoraddedv2>>ID,NAME,DESC`, `monitorremoved…` | | Monitor.cpp:387-398 |
| `activespecial>>WSNAME,MON` / `activespecialv2>>ID,NAME,MON` | special workspace toggles (game hidden behind scratchpad) | Monitor.cpp:1567-1689 |
| `configreloaded>>` | **re-install binds/rules now** | ConfigManager.cpp:854 |
| `custom>>DATA` | from `hl.dsp.event(DATA)` (our bind signals) | ConfigActions.cpp:1268-1271 |

Transient-focus gotchas (§8.2): when a keyboard-interactive layer surface loses focus, Hyprland may
emit `activewindow>>,` / `activewindowv2>>` **before** re-emitting the game. Debounce focus-off by
~100 ms, or re-query `j/activewindow`, before treating PoE2 as unfocused.

Alternative inside Hyprland: `hl.on("window.active", fn)` etc. (§2.5). These are lost on reload and
run with a 50 ms budget. socket2 is better for the backend.

---

## 5. Geometry, scale and placement

### 5.1 Queries (verified outputs)

```
$ hyprctl cursorpos            → 1176, 852          # global LOGICAL layout coords (floored)
$ hyprctl cursorpos -j         → {"x": 1176, "y": 852}
$ hyprctl monitors -j          → [{ "id":0, "name":"DP-1", "width":2560, "height":1440, "x":0, "y":0,
                                    "scale":1, "transform":0, "reserved":[0,26,0,0], "focused":true,
                                    "activeWorkspace":{"id":4,"name":"4"}, "solitary":"0",
                                    "solitaryBlockedBy":["WINDOWED","CANDIDATE"], "directScanoutTo":"0", … }]
$ hyprctl clients -j / activewindow -j → { "address":"0x…", "at":[12,38], "size":[2536,1390],
                                    "monitor":0, "class":…, "title":…, "xwayland":false,
                                    "fullscreen":0, "fullscreenClient":0, "workspace":{…}, "pid":…, … }
$ hyprctl layers -j            → { "DP-1": { "levels": { "0":[…], "1":[], "2":[{"namespace":"omarchy-bar",…}],
                                    "3":[ { "address":"0x…", "x":40, "y":40, "w":160, "h":60, "alpha":1,
                                            "namespace":"omaexiled-test", "pid":57427 } ] } } }
```

* `cursorpos`: `g_pInputManager->getMouseCoordsInternal().floor()`, i.e. **global logical**
  coordinates (HyprCtl.cpp:1291-1292).
* `monitors[].width/height` = **`m_pixelSize`** (mode pixels, pre-scale) (HyprCtl.cpp:238, 278). `x/y` =
  logical position. `reserved` order = `[left, top, right, bottom]` (logical).
* Logical monitor size: `(transform % 2 ? [height, width] : [width, height]) / scale` (transforms 1, 3,
  5, 7 rotate 90°/270°). Hyprland's layer arranger uses `m_size` (logical) and `m_position` (logical)
  (Renderer.cpp:2588).
* Window `at/size` are global logical (XWayland too, regardless of `xwayland:force_zero_scaling`).
* Layer levels: `0` background, `1` bottom, `2` top, `3` overlay.

### 5.2 Placing a layer surface near/opposite the cursor

Hyprland arranges a layer surface (Renderer.cpp:2587-2670, `arrangeLayerArray`):
* bounds = full monitor box if `exclusive_zone == -1`, else the **usable area** (monitor minus
  `reserved` minus other surfaces' exclusive zones, e.g. the 26 px omarchy bar).
  ⇒ **use exclusive zone `-1`** so margins are measured from the monitor edge even with the bar present
  or the game fullscreen.
* Anchored `TOP|LEFT` with desired size `w×h`: position = `bounds.(x,y) + (margin.left, margin.top)`.
  Anchoring both opposite edges with size 0 stretches. Both edges with a non-zero size centres and
  **ignores margins** on that axis.
* **No clamping**: off-screen margins put the surface partly off-screen. Clamp in the backend.
* Coordinates are logical and **output-local**. A layer surface lives on exactly one output, chosen at
  creation (`LayerShellQt::Window::setScreen` before `show()`). Moving to another monitor needs
  hide + show.

Backend formula (panel `pw×ph`, game window `g`, monitor `m`, cursor `c`, all logical):
```
mlx = m.x; mly = m.y;
mlw = (m.transform % 2 ? m.height : m.width) / m.scale;
mlh = (m.transform % 2 ? m.width : m.height) / m.scale;
// EE2-style: put the panel on the side of the game window opposite the cursor
const left = (c.x > g.at[0] + g.size[0] / 2) ? g.at[0] : g.at[0] + g.size[0] - pw;
const top  = g.at[1];
margins = { left: clamp(left - mlx, 0, mlw - pw), top: clamp(top - mly, 0, mlh - ph) }
```
With DESIGN.md's alternative (a surface anchored to all four edges, sized to the monitor, with a
`setMask` input region) no margins are needed. The renderer positions widgets in page coordinates, which
equal monitor-local logical coordinates when the surface covers the monitor with exclusive zone -1.

### 5.3 Fractional scale

Qt handles `wp_fractional_scale_v1`/viewporter. Hyprland has a special case for layer surfaces with a
viewport destination at fractional scale (LayerSurface.cpp:346-350). Sizes and margins sent through
layer-shell-qt are logical. `devicePixelRatio` in the page was `1` at scale 1 (verified).

---

## 6. layer-shell-qt 6.8.1 (installed)

Files (`pacman -Ql layer-shell-qt`): `/usr/include/LayerShellQt/{Window,Shell,window.h,shell.h,layershellqt_export.h}`,
`/usr/lib/libLayerShellQtInterface.so(.6, .6.8.1)`, Qt plugin `/usr/lib/qt6/plugins/wayland-shell-integration/liblayer-shell.so`,
QML module `org.kde.layershell` (`/usr/lib/qt6/qml/org/kde/layershell/`), CMake package
`/usr/lib/cmake/LayerShellQt/` (target `LayerShellQt::Interface`, `INTERFACE_LINK_LIBRARIES Qt6::Gui`,
include dir `${prefix}/include/`). **No pkg-config `.pc` and no qmake `.pri`.**

### 6.1 C++ API (`/usr/include/LayerShellQt/window.h`)

```cpp
namespace LayerShellQt {
class Window : public QObject {
  enum Anchor { AnchorNone=0, AnchorTop=1, AnchorBottom=2, AnchorLeft=4, AnchorRight=8 }; // Q_DECLARE_FLAGS(Anchors, Anchor)
  enum Layer { LayerBackground=0, LayerBottom=1, LayerTop=2, LayerOverlay=3 };
  enum KeyboardInteractivity { KeyboardInteractivityNone=0, KeyboardInteractivityExclusive=1, KeyboardInteractivityOnDemand=2 };
  static Window *get(QWindow *window);                 // creates/returns the per-window object (parented to the QWindow)
  void setAnchors(Anchors);            Anchors anchors() const;
  void setExclusiveZone(int32_t);      int32_t exclusionZone() const;
  void setExclusiveEdge(Window::Anchor);                // protocol v5+
  void setMargins(const QMargins &);   QMargins margins() const;   // QMargins(left, top, right, bottom)
  void setDesiredSize(const QSize &);  QSize desiredSize() const;  // null = use the QWindow size
  void setKeyboardInteractivity(KeyboardInteractivity);
  void setLayer(Layer);                                 // live change needs protocol v2+
  void setScope(const QString &);      QString scope() const;      // = layer namespace
  void setScreen(QScreen *);  void setWantsToBeOnActiveScreen(bool);
  void setCloseOnDismissed(bool);      // default true: compositor 'closed' → QWindow::close()
  void setActivateOnShow(bool);        // default true: xdg-activation request on show (skipped if interactivity None)
  // signals: anchorsChanged, exclusionZoneChanged, exclusiveEdgeChanged, marginsChanged, desiredSizeChanged,
  //          keyboardInteractivityChanged, layerChanged, wantsToBeOnActiveScreenChanged, screenChanged
};
}
```
`LayerShellQt::Shell::useLayerShell()` is **deprecated since 6.6** ("not needed since Qt 6.5"). Do not
call it: it would turn *every* window (including the settings window) into a layer surface.

**Defaults** (LSQ:src/interfaces/window.cpp:28-41): scope `"window"`, anchors **all four edges**,
exclusive zone 0, keyboard interactivity **OnDemand**, layer **Top**, desiredSize (0,0) (use window
size), screen null (= `QWindow::screen()`), `closeOnDismissed = true`, `activateOnShow = true`.
⇒ always set layer, anchors, interactivity and scope explicitly.

### 6.2 Lifecycle and ordering

* `Window::get(w)` installs an event filter. When the platform surface is created (`SurfaceCreated`),
  or immediately if `w->handle()` already exists, it calls `QWaylandWindow::setShellIntegration(layerShell)`
  (window.cpp:246-305). It warns `"already has a shell integration. Call QWindow::close() first and show
  it again."` if the window is already visible.
* The `zwlr_layer_surface_v1` is created when Qt creates the shell surface, i.e. on **`show()`**
  (`QWaylandWindow::setVisible(true)` → `initWindow()`, QTW:qwaylandwindow.cpp:644-656). At that moment
  `QWaylandLayerSurface` reads **output (screen / wantsToBeOnActiveScreen), layer and scope**
  (qwaylandlayersurface.cpp:22-44). ⇒ **Set scope, screen and initial layer before `show()`.** Scope
  ("namespace") is fixed for the surface's lifetime ("this is static and must be set before the platform
  window is created", window.cpp:141-145).
* `hide()` → `resetSurfaceRole()` deletes the shell surface (`zwlr_layer_surface_v1.destroy`), attaches
  a null buffer and commits (QTW:qwaylandwindow.cpp:657-664, 357-375). The next `show()` creates a fresh
  layer surface with the then-current properties. Hyprland emits `closelayer`/`openlayer` and runs
  layer fade animations unless a `no_anim` layer rule matches (§2.8). Verified: `openlayer>>omaexiled-test`,
  `closelayer>>omaexiled-test`.
* `QWindow::close()` destroys the platform window. Keep the QWindow and use `hide()`/`show()`.

### 6.3 Live changes after map (verified)

layer-shell-qt connects every property signal to the matching protocol request
(qwaylandlayersurface.cpp:45-91): `set_layer`, `set_anchor` (+ re-send size), `set_exclusive_zone`,
`set_exclusive_edge`, `set_margin(top, right, bottom, left)`, `set_size`, `set_keyboard_interactivity`.
`QWindow::resize()` → `QWaylandWindow::setGeometry` → `mShellSurface->setWindowSize()` → `set_size` if
`desiredSize` is null (qwaylandlayersurface.cpp:184-189, QTW:qwaylandwindow.cpp:~500-510). On anchored
axes (both opposite edges) size 0 is sent (`setDesiredSize`, lines 136-149). The compositor's later
`configure`s are applied via `applyConfigureWhenPossible()` (lines 104-118).

**All layer-surface state is double-buffered: it applies on the next `wl_surface.commit`.**
layer-shell-qt does **not** commit by itself. Verified experiment (QRasterWindow on the overlay layer,
anchors TOP|LEFT, margins 40,40, 160×60):

| step | `hyprctl layers -j` |
|---|---|
| `setMargins(240,40,0,0)` only | still `x=40` |
| + `requestUpdate()` (no repaint) | still `x=40` |
| + `update()` (repaint → commit) | `x=240` ✔ |
| `setKeyboardInteractivity(OnDemand)` + `setMargins` + `update()` | moved, **active window unchanged** ✔ |
| `w.resize(260,90)` | `w=260 h=90` ✔ (resize itself triggers a configure/commit cycle) |

⇒ After changing margins, anchors, interactivity, layer or exclusive zone, **call
`QQuickWindow::update()`** (forces a render + commit). DESIGN.md independently confirms this for
interactivity.

### 6.4 Input region, transparency, popups

* `QWindow::setMask(QRegion)` → `wl_surface.set_input_region(mask)` (empty mask = whole surface).
  `Qt::WindowTransparentForInput` flag → empty input region, fully click-through
  (QTW:qwaylandwindow.cpp:541-565, 681-700). This also only applies on the next commit, so call
  `update()`. Hyprland hit-tests layer surfaces against the input region; DESIGN.md verified clicks
  outside the mask reach the game.
* Transparent: `QQuickWindow::setDefaultAlphaBuffer(true)` (before creating windows) +
  `window->setColor(Qt::transparent)` (QML `color: "transparent"`) + `WebEngineView.backgroundColor:
  "transparent"` + page CSS `html, body { background: transparent }`. Verified rendering in a layer surface.
* Popups (e.g. `<select>` dropdowns, which QtWebEngine shows as separate popup windows): layer-shell-qt
  implements `attachPopup` → `zwlr_layer_surface_v1.get_popup(xdg_popup)` (qwaylandlayersurface.cpp:120-130),
  so xdg popups parented to the layer surface work. Positioning is subject to xdg-positioner
  constraints. Prefer HTML-rendered dropdowns in the renderer to avoid compositor popup grabs.
* `activateOnShow`: set `false` for the overlay (and keep interactivity None at show). Otherwise
  layer-shell-qt requests xdg-activation on show (qwaylandlayersurface.cpp:191-235).
* QML attached properties exist (`import org.kde.layershell 1.0 as LayerShell`;
  `LayerShell.Window.layer/anchors/margins/exclusionZone/keyboardInteractivity/scope/activateOnShow/
  wantsToBeOnActiveScreen/screen`). The C++ API is simpler for a stdio-driven host.
* The platform must be Wayland: force `qputenv("QT_QPA_PLATFORM", "wayland")` before `QGuiApplication`.
  This machine's env is `wayland;xcb`, and under xcb LayerShellQt prints "is not a wayland window. Not
  creating zwlr_layer_surface".

---

## 7. Overlay layer vs fullscreen, scanout, VRR (0.56.2 source)

* Render order per monitor: background → bottom → workspace windows (incl. fullscreen) → pinned →
  **top → overlay** (Renderer.cpp:1233-1242, comment "Render surfaces above windows for monitor").
* `onMap()` sets `m_aboveFullscreen = true` for **every** newly mapped layer (LayerSurface.cpp:167). When a
  layer changes layer at runtime: "if in fullscreen, only overlay can be above." (LayerSurface.cpp:328-331).
  Fullscreen transitions later reset `m_aboveFullscreen=false` for existing top-layer surfaces
  (Monitor.cpp:1513, 1573, 1622, 1641). **Overlay is the only layer that is unconditionally above.**
  The wiki's `allow_new_top_layers_over_existing_fullscreen` option is newer than 0.56.2.
* Input: "overlays are above fullscreen" (InputManager.cpp:470). With an exclusive fullscreen, a found
  layer surface is discarded only if it is below TOP or a TOP surface not above fullscreen
  (InputManager.cpp:498-503). Overlay surfaces always get pointer input.
* Performance: `isSolitaryBlocked` returns `SC_OVERLAYS` if the monitor's overlay layer list is
  non-empty (Monitor.cpp:1878-1880). **While our overlay surface exists, the fullscreen game loses direct
  scanout and tearing**, and the frame is composited. Destroying the surface on `hide()` (Qt does)
  removes it from the list (LayerSurface.cpp:93-94), so keep the overlay unmapped/hidden when idle
  (DESIGN.md: "mapped only while a widget … is visible").
* VRR: Omarchy's `misc.vrr = 3` (fullscreen with `content = "game"` only) and the `steam_app_*`
  `content = "game"` rule are unaffected by layer surfaces in the source I read. Not measured.

---

## 8. Keyboard focus and pointer behaviour of layer surfaces (0.56.2 source)

### 8.1 Map time
`CLayerSurface::onMap()` (LayerSurface.cpp:162-222):
```cpp
const bool GRABSFOCUS = ISEXCLUSIVE ||
    (interactivity != NONE && /* don't focus if constrained */ (no mouse || !g_pInputManager->isConstrained()));
if (GRABSFOCUS) { …; Desktop::focusState()->rawSurfaceFocus(layer surface); setPointerFocus(layer, local); }
```
⇒ **`on_demand` at map steals the keyboard** (DESIGN.md measured the same). `none` never does.

### 8.2 Interactivity changes after map (LayerSurface.cpp:369-407)
* `none → on_demand`: **no focus change** (no branch for it). Verified: active window unchanged.
* `* → exclusive`: immediate grab (`rawSurfaceFocus`, pointer focus to the layer).
* `exclusive → on_demand` while focused: `simulateMouseMovement()`. Focus stays if the pointer is over it.
* `on_demand/exclusive → none` while focused: `rawSurfaceFocus(nullptr)` then
  `refocusLastWindow(monitor)`, so **focus returns to the game**. `rawSurfaceFocus(nullptr)` posts
  `activewindow>>,` / `activewindowv2>>` (FocusState.cpp:240-246) before the game is re-focused and
  re-announced. That is the transient to debounce.

### 8.3 Hover and click (mouseMoveUnified, InputManager.cpp:230-745)
* Pointer focus goes to the overlay surface under the cursor **regardless of interactivity**
  (line 743 `setPointerFocus(foundSurface, …)`). An interactivity-None panel is fully clickable,
  scrollable and hoverable.
* Keyboard on hover: if the found layer surface's interactivity ≠ NONE and `follow_mouse != 3` (and no
  exclusive layer holds focus) → `rawSurfaceFocus(layer)` (line 733-736). With Omarchy's
  `follow_mouse = 1`, **hovering an `on_demand` panel gives it the keyboard**.
* Moving back over the game: `rawSurfaceFocus(gameSurface, game)` (line 700-720), so the **game gets the
  keyboard back** (`mouse_refocus = true` here). DESIGN.md measured both directions.
* Click: `processMouseDownNormal` only refocuses when the *window* under the cursor differs from the
  focused window (InputManager.cpp:899-910). `windowAt` ignores layers, so a click on the panel does
  **not** by itself give keyboard focus. Hover does (follow_mouse=1). With `follow_mouse = 0/2/3` there
  is no hover focus. The host must then set `exclusive` briefly, or return to `none` explicitly to give
  focus back.
* `exclusive` layers: all pointer events are forced to the exclusive surface even outside its bounds
  ("forced above all", InputManager.cpp:453-466), and clicking the game does not refocus it. Avoid
  `exclusive` except as a momentary "grab now" step (`exclusive` → commit → `on_demand` → commit).
* XWayland side effect: when a layer surface takes keyboard focus without a window owner, the previously
  focused surface is **deactivated** (`activateSurface(last, false)`, FocusState.cpp:238-239). The X11
  game gets FocusOut and may react (pause, mute in background, background FPS cap). It is re-activated
  when focus returns. Keeping the panel at `none` except while the user needs to type avoids this.
* `misc:layers_hog_keyboard_focus` (default true): defined in ConfigValues.cpp:489 but **not read** in
  InputManager.cpp, LayerSurface.cpp or FocusState.cpp of 0.56.2 (GitHub code search finds only the
  definition). Behaviour is fully described by the code above.

### 8.4 Recommended focus policy for the price panel
1. Show with `KeyboardInteractivityNone`, `activateOnShow(false)`.
2. After the first frame, switch to `OnDemand` + `update()`. The game keeps focus until the pointer
   moves over the panel, after which the panel can receive typing and Esc. This is DESIGN.md's choice
   and matches the source. Alternative if FocusOut on hover hurts the game: stay `None` and switch to
   `OnDemand` only when the renderer reports that an editable field gained focus (then the next motion
   grants focus), and back to `None` on blur, Esc or pointer leave (`QEvent::Leave` on the QWindow).
3. On hide: switch to `None` first (returns focus deterministically), then `hide()`.
4. Backend focus tracking: ignore `activewindow>>,` that is followed within ~100 ms by the game again.

### 8.5 Pointer constraints / confinement (risk)
* If the focused game surface has an active pointer constraint (zwp_pointer_constraints: Xwayland
  creates these for X11 pointer grabs with confine_to or for pointer-warp emulation), `mouseMoveUnified`
  confines or warps the pointer and **returns before hit-testing layers** (InputManager.cpp:312-330). The
  panel then gets **no pointer input**, and `on_demand` maps don't grab focus (§8.1 "don't focus if
  constrained").
* Same for the Hyprland window rule `confine_pointer` on the game (InputManager.cpp:331-341). Don't add it.
* PoE2 has a "confine mouse to window" style option. Keep it off and check in game (DESIGN.md lists
  this as unverified).

### 8.6 Window rules for our settings window (runtime, re-apply after reload)
The settings window is a normal xdg toplevel with app_id = `QGuiApplication::desktopFileName()` (e.g.
`omaexiled`). Useful runtime rules (`/eval`):
```lua
hl.window_rule({ name = "omaexiled-settings", match = { class = "^omaexiled$" },
                 float = true, center = true, size = { 1100, 760 }, tag = "-default-opacity", opacity = "1 1" })
```
(Effects names from wiki `window-rules.md`: `float`, `center`, `size`, `move`, `pin`, `no_initial_focus`,
`stay_focused`, `opacity`, `tag`, `no_blur`, `no_shadow`, `no_dim`, `no_shortcuts_inhibit`,
`confine_pointer`, `allows_input`, `render_unfocused`, …; Omarchy uses the same keys in `apps/steam.lua`.)
Optionally `hl.window_rule({ match = { class = "^steam_app_2694490$" }, no_shortcuts_inhibit = true })` if the
game ever inhibits shortcuts (alternative to `dont_inhibit` on each bind).

### 8.7 Layer rules (Lua, 0.56.2)
```lua
hl.layer_rule({ name = "omaexiled-noanim", match = { namespace = "^omaexiled" }, no_anim = true })
```
* Match props: `namespace` (RE2 regex). Effects (LuaBindingsConfigRules.cpp:182-193): `no_anim` (bool),
  `blur` (bool), `blur_popups` (bool), `ignore_alpha` (float 0..1, the old `ignorezero`/`ignorealpha`:
  blur ignores pixels with alpha ≤ value), `dim_around` (bool), `xray` (bool), `animation` (string, e.g.
  `"none"`, `"fade"`, `"slide"`), `order` (int, reservation order), `above_lock` (0..2),
  `no_screen_share` (bool). Plus `name` (named rules are replaced when re-declared, so the call is
  idempotent) and `enabled`.
* Returns a handle with `:set_enabled(bool)`/`:is_enabled()`.
* Omarchy's own example: `hl.layer_rule({ match = { namespace = "omarchy-bar" }, no_anim = true, animation = "none" })`
  (`/usr/share/omarchy/default/hypr/apps/omarchy-shell.lua:5`).
* Blur behind a translucent panel: `blur = true, ignore_alpha = 0.01` (so fully transparent areas are
  not blurred). Rules are lost on reload, so re-apply with the binds.

---

## 9. Qt host: QtWebEngine + layer-shell-qt

### 9.1 Installed toolchain (verified)

| Item | Version / path |
|---|---|
| qt6-base, qt6-declarative, qt6-wayland, qt6-webchannel | 6.12.0 |
| qt6-webengine | package `6.11.2-2`; libraries named `libQt6WebEngine*.so.6.12.0`, `.pri`/`.pc` say 6.12.0; **runtime UA `QtWebEngine/6.11.2 Chrome/140.0.0.0`** |
| layer-shell-qt | 6.8.1-1 (installed today) |
| qmake6 | `/usr/bin/qmake6`, QMake 3.1, Qt 6.12.0, spec linux-g++ |
| compilers | g++ 16.2.1, clang++, GNU make 4.4.1, pkgconf 3.0.10 |
| bun | 1.4.3 |
| wl-clipboard | 2.3.0 (`wl-copy`, `wl-paste`) |
| also present | jq 1.8.2, socat 1.8.1, qmllint/qmlformat/qmlls (`/usr/lib/qt6/bin`) |
| **not installed, not needed** | cmake, extra-cmake-modules, qt6-tools (Designer/Linguist), wev (keysym debugging; optional: `pacman -S wev`) |
| not recommended | ydotool/wtype are installed but must not be used for injection (§3.4) |

### 9.2 Verified qmake project

Built and linked cleanly (0 warnings) in a scratch dir. `ldd` shows `libLayerShellQtInterface.so.6`,
`libQt6WebEngineQuick.so.6`, `libQt6WebChannel(.Quick).so.6`:

```qmake
TEMPLATE = app
TARGET   = omaexiled-host
CONFIG  += c++20 release warn_on
CONFIG  -= app_bundle
QT      += core gui quick qml webenginequick webenginecore webchannel webchannelquick
# Widgets variant only (NOT recommended for the overlay, see 9.3):
# QT    += widgets webenginewidgets

# LayerShellQt ships only a CMake package (no .pc, no .pri). Headers live in
# /usr/include/LayerShellQt/ (default include path → #include <LayerShellQt/Window>).
# Do NOT add INCLUDEPATH += /usr/include (it can break libstdc++'s #include_next).
LIBS    += -lLayerShellQtInterface

SOURCES += src/main.cpp src/host.cpp
HEADERS += src/host.h
RESOURCES += qml.qrc
```
Build: `qmake6 host.pro && make -j$(nproc)`. The CMake equivalent (for reference only) is
`find_package(LayerShellQt REQUIRED)` + `target_link_libraries(app LayerShellQt::Interface)`.

### 9.3 QML/QQuickWindow vs QWidget QWebEngineView
* **Use `QQuickWindow` + QML `WebEngineView`.** Verified on this machine (scratch `wetest`): a QML
  `Window { visible: false; color: "transparent" }` containing `WebEngineView { backgroundColor:
  "transparent" }`, made a layer surface in C++ with `LayerShellQt::Window::get(win)` before
  `win->show()`, mapped on level 3 with namespace `omaexiled-wetest` at the requested margins. The
  active window was unchanged (interactivity None), and the page loaded (`LoadSucceededStatus`). DESIGN.md
  reports the same with `QQuickView` and live resizing.
* A top-level `QWebEngineView` (QWidget) compiles with LayerShellQt, but DESIGN.md measured that it
  **maps as a normal xdg toplevel**. Probably because the widget window switches to an RHI surface
  type and its platform window is re-created after the shell integration was assigned. Don't use it for
  the overlay. (It would be fine for the settings window, but sharing one QML code path is simpler.)

### 9.4 Startup ordering (C++)
```cpp
int main(int argc, char **argv) {
    // 0) protect the stdio protocol channel (see 9.8) BEFORE anything can print
    int protoOut = dup(STDOUT_FILENO); dup2(STDERR_FILENO, STDOUT_FILENO);
    qputenv("QT_QPA_PLATFORM", "wayland");          // layer-shell requires Wayland
    qputenv("QT_FORCE_STDERR_LOGGING", "1");        // otherwise Qt logs go to journald (verified)
    // optional: qputenv("QTWEBENGINE_CHROMIUM_FLAGS", "...");  qputenv("QTWEBENGINE_REMOTE_DEBUGGING", "127.0.0.1:9229");
    // optional custom scheme: QWebEngineUrlScheme s("omaexiled"); ...; QWebEngineUrlScheme::registerScheme(s);  (must be before app)
    QCoreApplication::setAttribute(Qt::AA_ShareOpenGLContexts);   // initialize() also sets it
    QtWebEngineQuick::initialize();                 // MUST be before Q(Gui)Application is constructed
    QGuiApplication app(argc, argv);
    QGuiApplication::setDesktopFileName("omaexiled");   // xdg app_id of the settings window
    QQuickWindow::setDefaultAlphaBuffer(true);
    ...
}
```
* `QtWebEngineQuick::initialize()` (header `QtWebEngineQuick/qtwebenginequickglobal.h`) sets up a shared
  OpenGL context and must run before the `QGuiApplication` is created (Qt docs). Verified working order
  above.
* On this NVIDIA box Chromium logs `GBM is not supported with the current configuration. Fallback to
  Vulkan rendering in Chromium.` and renders correctly. If GPU issues appear, try
  `QTWEBENGINE_CHROMIUM_FLAGS="--disable-gpu-compositing"` (or `--disable-gpu` as last resort).
* Chromium switches on the command line must follow `--webEngineArgs` in Qt 6 (e.g.
  `omaexiled-host --webEngineArgs --remote-debugging-port=9229`). The env var
  `QTWEBENGINE_CHROMIUM_FLAGS` avoids that.

### 9.5 Profile, page settings, context menu, links
* Persistent profile (C++ widgets API): `QWebEngineProfileBuilder().setPersistentStoragePath(dir)
  .setCachePath(cacheDir).setPersistentCookiesPolicy(...).createProfile("omaexiled")` (header
  `QWebEngineProfileBuilder`, Qt ≥ 6.9; present here). For QML: `WebEngineProfilePrototype { storageName:
  "omaexiled"; persistentStoragePath: …; cachePath: … }` (QML type exported since 6.9, verified in
  `/usr/lib/qt6/qml/QtWebEngine/plugins.qmltypes:2508-2512`), then `profile: proto.instance()`. Or the
  older `WebEngineProfile { storageName: "omaexiled"; offTheRecord: false; persistentStoragePath: … }`.
  Use **one profile for both windows** so localStorage is shared. Suggested paths:
  `~/.local/share/omaexiled/webengine`, `~/.cache/omaexiled/webengine`.
* Context menu: QML `onContextMenuRequested: (req) => { req.accepted = true }` suppresses Qt's menu
  (verified compiles and runs). Widgets: `view->setContextMenuPolicy(Qt::NoContextMenu)`. The DOM
  `contextmenu` event still fires for the renderer's own handling.
* Background: QML `backgroundColor: "transparent"`; widgets `page->setBackgroundColor(Qt::transparent)`.
* Settings worth setting (`WebEngineView.settings.*` / `QWebEngineSettings`): `javascriptCanAccessClipboard`
  / `javascriptCanPaste` (if the renderer uses `navigator.clipboard`), `showScrollBars`,
  `focusOnNavigationEnabled: false` (don't grab focus on load), `localStorageEnabled` (default on),
  `playbackRequiresUserGesture`, `errorPageEnabled`. (Enum names verified in `qwebenginesettings.h`.)
* External links / `window.open` / `target=_blank`: handle `onNewWindowRequested` (QML) /
  `QWebEnginePage::newWindowRequested` and open via `QDesktopServices::openUrl` or forward to the
  backend (`xdg-open`). Block navigation away from the app origin in `onNavigationRequested`.
* Zoom: `WebEngineView.zoomFactor` / `QWebEnginePage::setZoomFactor` (if EE2's font-size/zoom setting
  maps to page zoom).

### 9.6 Loading the renderer: http://127.0.0.1:PORT vs custom scheme
* **Recommended: `http://127.0.0.1:<port>/…` served by Bun.** Same origin for `/proxy/*`, `/api/*` and
  `ws://127.0.0.1:<port>/events`. Chromium treats `127.0.0.1` as a secure context. No scheme handler
  needed.
* Custom scheme (`QWebEngineUrlScheme::registerScheme` before the app, `QWebEngineUrlSchemeHandler` in
  the profile) would make every `fetch` to the backend cross-origin (CORS) and needs a C++ proxy. Not
  worth it.
* **Security:** any page in the user's normal browser can open `ws://127.0.0.1:<port>/events` (WebSockets
  are not CORS-protected) and could trigger chat macros or the trade proxy. The backend should check the
  `Origin` header (`http://127.0.0.1:<port>`) and/or require a random per-run token (host passes it in
  the URL, e.g. `/?token=…`, and the renderer adds it to the WS URL).

### 9.7 QWebChannel (optional)
Only needed if the renderer must call the host directly (e.g. low-latency "set input region" or "resize
to content" without a backend hop):
* C++: `QWebChannel ch; ch.registerObject("host", hostObj); page->setWebChannel(&ch /*, worldId*/);`
  (`QWebEnginePage::setWebChannel(QWebChannel*, quint32 worldId = 0)`). QML: `WebEngineView { webChannel:
  WebChannel { registeredObjects: [hostObj] } }` (needs `import QtWebChannel`, module `webchannelquick`).
* JS side needs `qwebchannel.js`. From an `http://` page, inject it as a `QWebEngineScript` (source read
  from Qt resource `:/qtwebchannel/qwebchannel.js`, injection point DocumentCreation, same world), then
  `new QWebChannel(qt.webChannelTransport, ch => …)`.
* Simpler and consistent with the architecture: route host commands renderer → backend (WS) → host
  (stdio). That costs about 1 ms.

### 9.8 stdio JSON channel hygiene
* QtWebEngine spawns `QtWebEngineProcess` children (zygote, renderer, GPU) that **inherit stdout/stderr**.
  Chromium and Qt log noise must never reach the JSON channel. Do the `dup(1)`/`dup2(2,1)` swap at the
  very top of `main` and write protocol lines to the saved fd (or use an extra pipe fd from Bun).
* Read stdin with `QSocketNotifier(STDIN_FILENO, QSocketNotifier::Read)`, accumulate and split on `\n`,
  parse with `QJsonDocument::fromJson`. On EOF (backend died) `QCoreApplication::quit()`. Also consider
  `prctl(PR_SET_PDEATHSIG, SIGTERM)`.
* Qt logging: with stderr not a TTY, Qt 6 logs to **journald** unless `QT_FORCE_STDERR_LOGGING=1`
  (verified: QML `console.log` only appeared on stderr with that env set). `WebEngineView.onJavaScriptConsoleMessage`
  can forward renderer console output to the backend.

### 9.9 Devtools (verified)
* `QTWEBENGINE_REMOTE_DEBUGGING=127.0.0.1:9339` (or just a port): stderr prints `DevTools listening on
  ws://127.0.0.1:9339/devtools/browser/…` and `Added {--remote-allow-origins=*} …`.
  `curl http://127.0.0.1:9339/json/version` → `"Browser": "wetest/"`, `"User-Agent": "… QtWebEngine/6.11.2
  Chrome/140.0.0.0 …"`, `"V8-Version": "14.0.365.10"`. `/json/list` lists the page with
  `devtoolsFrontendUrl`. Open `chrome://inspect` in Chromium. **Dev builds only** (it is an unauthenticated
  local debug port).
* In-app inspector: `page->setDevToolsPage(devPage)` / QML `devToolsView: otherWebEngineView`, shown in a
  normal window.

### 9.10 Minimal host skeleton (overlay part)

```cpp
// after app + profile creation
QQmlApplicationEngine engine;            // or QQuickView
engine.load(QUrl("qrc:/Overlay.qml"));   // Window { visible:false; color:"transparent"; WebEngineView{…} }
auto *win = qobject_cast<QQuickWindow*>(engine.rootObjects().first());
auto *ls  = LayerShellQt::Window::get(win);           // BEFORE show()
ls->setScope("omaexiled");                            // fixed for the surface lifetime
ls->setLayer(LayerShellQt::Window::LayerOverlay);
ls->setExclusiveZone(-1);                             // ignore the bar's reserved zone
ls->setKeyboardInteractivity(LayerShellQt::Window::KeyboardInteractivityNone);
ls->setActivateOnShow(false);
ls->setCloseOnDismissed(false);                       // output removed → we decide (re-show elsewhere)
// variant A (DESIGN.md): full monitor + input mask
ls->setAnchors({LayerShellQt::Window::AnchorTop | LayerShellQt::Window::AnchorBottom |
                LayerShellQt::Window::AnchorLeft | LayerShellQt::Window::AnchorRight});
// variant B: panel-sized → AnchorTop|AnchorLeft + setMargins(QMargins(left, top, 0, 0)) + win->resize(w, h)
ls->setScreen(screenForName("DP-1"));                 // QScreen::name() == Hyprland monitor name

// show:
win->show();
QTimer::singleShot(0, win, [=]{ /* after first frame */ ls->setKeyboardInteractivity(
      LayerShellQt::Window::KeyboardInteractivityOnDemand); win->update(); });
// input region (variant A):
win->setMask(QRegion(widgetRects)); win->update();
// move (variant B):
ls->setMargins(QMargins(x, y, 0, 0)); win->update();
// hide:
ls->setKeyboardInteractivity(LayerShellQt::Window::KeyboardInteractivityNone); win->update(); win->hide();
```
Use `QQuickWindow::frameSwapped` or `afterRendering` to detect "after first frame" instead of a 0 ms timer.

---

## 10. Raw evidence

### 10.1 Layer-shell experiments (scratch programs, run on this desktop; each lived ≤ 4 s)
```
# QRasterWindow, overlay, TOP|LEFT, margins 40,40, 160x60, interactivity None, activateOnShow false
before:  activewindow address 0x55755c1d1840 ; cursor 905, 805
layers1: {'x': 40, 'y': 40, 'w': 160, 'h': 60, 'namespace': 'omaexiled-test'}  level 3
(after setKeyboardInteractivity(OnDemand) + setMargins(240,40) + update())
layers2: {'x': 240, 'y': 40, 'w': 160, 'h': 60, ...}   activewindow still 0x55755c1d1840
(after resize(260,90))
layers3: {'x': 240, 'y': 40, 'w': 260, 'h': 90, ...}
socket2: [364ms] openlayer>>omaexiled-test   [2981ms] closelayer>>omaexiled-test

# commit test: setMargins only → x=40 ; +requestUpdate() → x=40 ; +update() → x=240

# QML Window + WebEngineView (transparent), overlay layer, namespace omaexiled-wetest
level 3 {'x': 40, 'y': 40, 'w': 300, 'h': 120, 'namespace': 'omaexiled-wetest'}; activewindow unchanged
stderr (QT_FORCE_STDERR_LOGGING=1):
  GBM is not supported with the current configuration. Fallback to Vulkan rendering in Chromium.
  qml: loading status 0
  qml: JS: dpr=1 ua=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) QtWebEngine/6.11.2 Chrome/140.0.0.0 Safari/537.36
  qml: loading status 2
```
(Another process was showing a full-screen `omaexiled-spike` overlay surface during these runs, probably
a parallel experiment. It did not affect the results above.)

### 10.2 `hyprctl binds -j` entry (user's existing Lua bind)
```json
{ "locked": false, "mouse": false, "release": false, "repeat": false, "longPress": false,
  "non_consuming": false, "auto_consuming": false, "has_description": true, "modmask": 12,
  "submap": "", "submap_universal": "false", "key": "D", "keycode": 0, "catch_all": false,
  "description": "PoE2 price check", "allow_input_capture": false, "dispatcher": "__lua", "arg": "49" }
```
(modmask 12 = CTRL(4) | ALT(8).)

### 10.3 Key stub excerpts (`/usr/share/hypr/stubs/hl.meta.lua`)
```lua
---@class HL.BindOptions  (437-453)
---@field repeating? boolean  ---@field locked? boolean  ---@field release? boolean
---@field non_consuming? boolean  ---@field transparent? boolean  ---@field ignore_mods? boolean
---@field dont_inhibit? boolean  ---@field long_press? boolean  ---@field submap_universal? boolean
---@field click? boolean  ---@field drag? boolean  ---@field description? string  ---@field desc? string
---@field device? {inclusive?: boolean, list?: string[]}  ---@field allow_input_capture? boolean
-- (auto_consuming is accepted by the 0.56.2 source, LuaBindingsToplevel.cpp:192, though missing from the stub's BindOptions)
---@class HL.LayerRuleSpec (555-569): above_lock animation blur blur_popups dim_around enabled ignore_alpha match name no_anim no_screen_share order xray
---@class HL.LayerSurface (679-692): above_fullscreen address h interactivity layer mapped monitor namespace pid w x y
---@field bind fun(keys: string, dispatcher: HL.Dispatcher|function, opts?: HL.BindOptions): HL.Keybind   (822)
---@field unbind fun(key: string): nil   (860)
---@field dispatch fun(dispatcher: HL.Dispatcher|function): any   (828)
---@class HL.DspNamespace (870-891): dpms event exec_cmd exec_raw exit focus force_idle force_renderer_reload global layout no_op pass release_input_capture send_key_state send_shortcut submap cursor group window workspace
```

### 10.4 Omarchy references (read-only)
* `/usr/share/omarchy/default/hypr/bindings/clipboard.lua:1-47`: `send_key_state` down + `hl.timer` 50 ms up
  pattern. The comment: "Send with explicit mods to the focused surface by omitting the window target, so
  universal clipboard shortcuts reach both normal windows and focused layer-shell surfaces… A virtual
  keyboard (wtype) won't do: the physically held SUPER merges into the injected chord at the seat."
* `/usr/share/omarchy/default/hypr/bindings/voxtype.lua:3-4`: `{ release = true }` example.
* `/usr/share/omarchy/default/hypr/bindings/media.lua`: `{ locked = true, repeating = true }` examples.
* `/usr/share/omarchy/default/hypr/apps/omarchy-shell.lua:5,10`: layer rules by namespace.

### 10.5 URLs
* Wiki sources (main): `https://github.com/hyprwm/hyprland-wiki/tree/main/content/configuring/core/binds/`
  (`_index.md`, `flags.md`), `…/configuring/core/dispatchers.md`, `…/configuring/core/rules/layer-rules.md`,
  `…/configuring/core/rules/window-rules.md`, `…/configuring/core/advanced-configuration/events.md`,
  `…/configuring/core/advanced-configuration/using-hyprctl.md`, `…/content/ipc/_index.md`,
  `…/configuring/selectors.md`. Rendered: `https://wiki.hypr.land/configuring/core/binds/` etc.
* Hyprland source at tag: `https://github.com/hyprwm/Hyprland/tree/v0.56.2` (files cited above:
  `src/debug/HyprCtl.cpp`, `src/config/lua/ConfigManager.{cpp,hpp}`, `src/config/lua/bindings/LuaBindings{Toplevel,Dispatchers,Registration,ConfigRules,Internal}.cpp`,
  `src/config/lua/objects/LuaKeybind.cpp`, `src/config/shared/actions/ConfigActions.cpp`,
  `src/managers/KeybindManager.cpp`, `src/managers/EventManager.cpp`, `src/managers/input/InputManager.cpp`,
  `src/desktop/state/FocusState.cpp`, `src/desktop/view/LayerSurface.cpp`, `src/desktop/view/Window.cpp`,
  `src/render/Renderer.cpp`, `src/output/Monitor.cpp`, `src/managers/fullscreen/FullscreenController.cpp`,
  `src/xwayland/XWM.cpp`, `src/SharedDefs.hpp`, `src/config/values/ConfigValues.cpp`).
* layer-shell-qt: `https://invent.kde.org/plasma/layer-shell-qt` (tag v6.8.1; `src/interfaces/window.{h,cpp}`,
  `src/qwaylandlayersurface.cpp`, `tests/main.cpp`, `tests/quicktest.qml`, `README.md`).
* QtWaylandClient (in qtbase 6.12): `https://github.com/qt/qtbase/blob/v6.12.0/src/plugins/platforms/wayland/qwaylandwindow.cpp`.
* Omarchy stuck-key discussion referenced in Omarchy: `https://github.com/hyprwm/Hyprland/discussions/14099`.

---

## 11. Edge cases and risks (checklist for implementers)

1. **Config reload wipes runtime state**: binds, layer/window rules, `_G.omaexiled`. Re-apply on
   `configreloaded>>` and on backend start. Also check that `hyprctl binds -j` contains our descriptions
   after start, and self-heal if not.
2. **Never `hl.unbind`/`:remove()`** our combos (collateral removal of user binds). Use `:set_enabled(false)`
   and a generation hash.
3. Bind callbacks: keep under 100 ms. No `io.popen`, sleeps or clipboard calls. Only `hl.get_active_window()`
   and `hl.dispatch(...)`.
4. `send_shortcut` from inside a bind callback sends press only (release deferred). Inject from the
   backend over IPC, or use `send_key_state` down/up + `hl.timer`.
5. Pasting into the game only works while the game (an Xwayland surface) holds seat keyboard focus (XWM
   focus gate).
6. Transient `activewindow>>,` events around layer focus changes: debounce.
7. Addresses: socket2 `abc123` vs JSON/Lua `0xabc123`.
8. socket2 drops slow readers at 64 queued events: read continuously, reconnect, re-query.
9. Request socket: single `write()`, avoid request lengths that are exact multiples of 1023, close
   promptly, never batch Lua.
10. Overlay surface present ⇒ no direct scanout/tearing for the fullscreen game. Unmap when idle.
11. Map with interactivity **None**, switch to OnDemand after the first frame (+ `update()`), go back to
    None before hide. Never map with OnDemand while the game is focused.
12. Pointer constraints / `confine_pointer` on the game make the panel unreachable by the pointer.
13. In-game Windowed Fullscreen (`fullscreen=2`) broke injection and clicks in 0.55.2 tests with the old
    XWayland overlay. Re-test with the layer-shell overlay. Binds use `dont_inhibit = true`.
14. Layer-shell state (margins, size via desiredSize, interactivity, mask) needs a commit: call
    `QQuickWindow::update()` after every change.
15. Scope/namespace and output are fixed at `show()`. Changing monitor = hide + set screen + show.
16. Layer fade animation (~400 ms Omarchy default): add the `no_anim` layer rule for `^omaexiled`.
17. Qt logs go to journald unless `QT_FORCE_STDERR_LOGGING=1`. Chromium children inherit stdout, so move
    the protocol off fd 1.
18. Force `QT_QPA_PLATFORM=wayland` in the host (`wayland;xcb` in the session env could fall back to xcb).
19. `QT_IM_MODULE=fcitx` is set: typing into the panel goes through fcitx when it has focus (normally fine).
20. Monitor `width/height` in `hyprctl monitors` are pixels. Divide by `scale` (and swap for odd
    transforms) for logical.
21. The user's old `poe-pricecheck.sh` uses legacy `hyprctl dispatch sendshortcut …` and fails under the
    Lua config. Their `CTRL + ALT + D` bind still exists in `~/.config/hypr/bindings.lua`.
