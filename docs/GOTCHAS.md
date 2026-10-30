# Gotchas

Things that cost real debugging time on Omarchy / Hyprland 0.56 with PoE2
under Proton. Each entry: the symptom, the cause, what OmaExiled does about
it, and how to tell if it is back. Read this before changing input,
focus, key injection or the overlay surface.

## In the game

### The panel shows but clicks go through to the game (Ctrl+Alt+D, and every panel)

**Symptom.** The price panel is drawn above PoE2, but clicking it makes the
character move or cast a skill; nothing in the panel reacts. Locked mode
(`Ctrl+Alt+D`) looked worst because the whole screen is supposed to belong
to the overlay there.

**Causes (there were two at once).**

1. **An old bind on the same key.** The user's previous price checker
   (`~/Developer/poe_price_checker`, bound to `CTRL + ALT + D` in
   `~/.config/hypr/bindings.lua`) ran on every `Ctrl+Alt+D` and showed its own
   QuickShell overlay on top of ours. The bind is now commented out (with a
   `.bak` of the file). The backend logs every combo that also has a
   non-OmaExiled bind at startup:
   `warn [Shortcuts] Hotkey "Ctrl + Alt + D" is also bound in Hyprland ("…")`.
   If that line appears, something else will fire together with ours.
2. **PoE2 confines the pointer.** Wine/Proton confines the cursor to the
   game window. Hyprland honours a pointer constraint only while the
   constrained surface has keyboard focus, and while it is active Hyprland
   never re-focuses the pointer on motion, so it never reaches the overlay
   layer even inside its input region. Our fake test game did not confine the
   pointer, which is why every automated test passed and only the real game
   showed it.

**Fix.** While a panel is shown the backend polls the cursor (50 ms) and
sends the host `overlay.keyboard {grab: true}` while the cursor is over the
panel or the overlay is active. The host switches the layer to an
*exclusive* keyboard grab; the game loses keyboard focus, its constraint is
released, and the pointer reaches the panel. Off the panel `grab: false`
gives the game the keyboard back. (`backend/src/overlay-state.ts`
`pollPointer`, `host/src/overlay.cpp` `setKeyboardGrab`.)

**Check.** `omaexiled ctl status` with the cursor over an open panel must
show `"hostKeyboardFocus": true`; over the game, `false`. A pointer that
`hyprctl cursorpos` reports over the panel while `hostKeyboardFocus` stays
`false` means the grab is not happening.

### F5 typed `v` into chat instead of `/hideout`

**Cause.** Wine ignores the modifier state carried by an injected key event
and only tracks modifiers it saw pressed as keys. Hyprland's
`send_shortcut` / `send_key_state` with `mods = "CTRL"` sets that state on
the `V` key event, so the game saw a plain `v`. Qt and other native clients
honour the mask, so the fake game worked.

**Fix.** Every chord is typed like a person would: `Control_L` down,
`Alt_L` down, the key down, then the key and modifiers up
(`_G.omaexiled.chord` in the generated binds Lua, `backend/src/binds.ts`).

**Same bug, quieter symptom.** The copy chord is `Ctrl+Alt+C`. With the
mask-only injection the game got Ctrl (physically held by the user's
`Ctrl+D`) but not Alt, so it made a *simple* copy without mod details: the
panel showed fewer stats and no "Tier" tags. Tier tags on mods are the quick
proof that the advanced copy worked.

### Ctrl+D opened the Character panel

**Cause.** Pressing `Ctrl+D` holds a real Ctrl. When the user lets go of it
between our injected `Control_L` down and `C` down, the game sees a plain
`C`, which toggles the Character panel. A race: it worked once and failed
the next time.

**Fix.** `M.chord` sends all the presses inside one `/eval`, i.e. in one
compositor call, so no real key event can land between them. The releases
follow 20 ms later from an `hl.timer`.

### The first click with Ctrl+D did nothing, `No item text found`

The game copies only the item under its own cursor. During automated tests
a cursor *warp* (`hl.dsp.cursor.move`) does not make Wine register a hover;
a small real motion afterwards does (`ydotool mousemove -x 2 -y 1`). With a
real mouse this never happens. `warn [ClipboardPoller] No item text found.`
otherwise means the cursor was not over an item, or the copy chord did not
reach the game (look for the Character panel opening: see above).

### Display mode

Tested and working: **Windowed Fullscreen** (borderless, full screen). Plain
**Fullscreen** was where the click problem was first seen; with the keyboard
grab fix it may work too, but it is not verified. Windowed mode is not
needed.

### F9 also starts dictation

Omarchy binds `F9` to push-to-talk dictation; EE2's default `/exit` macro is
also `F9`. Both fire while PoE2 is focused. Rebind one of them.

### Searches without clicking

EE2 (from Awakened PoE Trade) runs the search when the mouse moves from the
filter list onto the Search button area, with no setting. OmaExiled keeps it
behind *Settings → Price check → Search when the mouse moves from the
filters onto the Search button*, off by default, so a click is the only
trigger and no rate limit is spent by accident. Separately, *Perform an auto
search, when pressing* (per hotkey) auto-searches uniques, charms,
unidentified items and similar on open.

## Hyprland 0.56 (Lua config)

- `hyprctl dispatch` takes Lua dispatcher expressions
  (`hl.dsp.focus({ window = "address:0x…" })`), not the old
  `dispatcher args` strings. `hyprctl keyword` is refused.
- `hl.unbind(combo)` and a bind handle's `remove()` delete **every** bind on
  that combo, including the user's. OmaExiled only ever `set_enabled()`s its
  own handles.
- Every config reload (and Omarchy reloads on any file save under
  `~/.config/hypr`) drops runtime binds and rules. The backend reinstalls on
  `configreloaded>>`.
- `send_shortcut` inside a bind callback sends only the press and defers the
  release (stuck keys). Keys are sent from the backend over `/eval`, never
  from a callback.
- The binds' callbacks pass keys through unless a lease
  (`_G.omaexiled.lease`, renewed every 5 s) is valid, so a killed or hung
  backend stops eating PoE2 hotkeys within 15 s. `omaexiled disable-binds`
  (also run when the service stops) does it at once.
- Large Lua over the request socket is unreliable (reads stop at a chunk
  shorter than 1023 bytes); the binds module is written to a file and loaded
  with `dofile`.

## Wayland overlay (Qt + layer-shell)

- A `QWidget` `QWebEngineView` cannot become a layer surface (it maps as a
  normal window). The host uses `QQuickView` + `WebEngineView`, made a layer
  surface with `LayerShellQt::Window::get()` before `show()`.
- Mapping a layer with keyboard `on_demand` takes the keyboard from the game
  at once. The host maps with `none` and switches only after the compositor
  has shown the first frame (Qt's second frame swap).
- layer-shell-qt property changes (margins, keyboard, mask) apply only on
  the next surface commit: call `QQuickWindow::update()` after them.
- `QWindow::setMask(QRegion())` means *the whole surface*, and Qt skips a
  mask equal to the previous one, even after `hide()`/`show()` re-created
  the `wl_surface`. Mixing that with `Qt::WindowTransparentForInput` left the
  active (full) overlay click-through. The host now always sets an explicit
  region (none = a 1 px rect outside the surface, full = a rect larger than
  any output) and resets the mask before setting it.
- Quickshell 0.3.2's own WebEngine support hangs at start, so the web UI
  cannot live inside omarchy-shell.
- While any overlay-layer surface is mapped the game's monitor loses direct
  scanout; the surface is destroyed whenever nothing is shown.

## Development

- Never `pkill -f <pattern>`: the pattern also matches the shell running
  it. Use `pkill -x <name>` or a pid.
- The renderer's `*.index.bin` data files are generated
  (`npm run make-index-files`, done by `make build`); without them most
  parser tests fail and the app cannot start.
- Sockette (the renderer's WebSocket) stops reconnecting on close codes
  1000/1001/1005; the backend closes with other codes.
- `item-text` goes to the overlay page only (`/events?role=overlay`); EE2's
  "last active client" routing let any other client (settings window, a
  debugging WebSocket) steal price checks.
