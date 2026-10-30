# OmaExiled

Path of Exile 2 price checker for [Omarchy](https://omarchy.org) (Arch +
Hyprland + omarchy-shell). It is a native Wayland port of the price-check
features of [Exiled Exchange 2](https://github.com/Kvan7/Exiled-Exchange-2):
the same parser, filters, trade search and UI, shown in a Wayland overlay
above the game instead of an Electron window.

What you get:

- price check (quick and locked), with EE2's filters, presets, bulk exchange,
  trends and related items
- item check (`Alt+D`) with its wiki, poedb and Craft of Exile links
- stash search hotkeys
- chat macros (`/hideout`, `/exit`, `@last ty`, `/invite @last`, ...)
- an omarchy-shell bar icon with EE2's tray menu (settings, league, browser,
  config folder, quit)

Hotkeys only act while Path of Exile 2 is the focused window; everywhere else
the keys work as usual.

## Credits

- [Exiled Exchange 2](https://github.com/Kvan7/Exiled-Exchange-2) by Kvan7
  (MIT). OmaExiled's renderer is EE2's Vue app.
- [Awakened PoE Trade](https://github.com/SnosMe/awakened-poe-trade) by
  SnosMe (MIT), which EE2 is a fork of.

OmaExiled is MIT licensed as well (see `LICENSE`). It is not affiliated with
or endorsed by Grinding Gear Games.

## Requirements

Omarchy with Hyprland 0.56 or newer, plus:

```bash
sudo pacman -S --needed layer-shell-qt qt6-webengine bun nodejs npm base-devel
```

`layer-shell-qt` is the one package a fresh Omarchy never has. The others may
already be installed (Node.js from mise works too). Everything else OmaExiled
uses (`wl-clipboard`, `jq`, `xdg-open`, omarchy-shell) is part of Omarchy.

## Install

```bash
git clone <this repository> ~/Developer/OmaExiled
~/Developer/OmaExiled/bin/omaexiled install
```

`install` builds everything (`make`), installs and starts the
`omaexiled.service` systemd user unit, links `~/.local/bin/omaexiled`, copies
the bar widget to `~/.config/omarchy/plugins/omaexiled/` and puts it on the
right side of the bar. It is safe to run again after `git pull`: it rebuilds,
updates what changed and restarts the service.

The service starts with your graphical session. On first start, settings from
an Exiled Exchange 2 install (`~/.config/exiled-exchange-2/apt-data/config.json`)
are imported once.

## Usage

Hover an item in game and press a hotkey:

| Action | Default | Notes |
|---|---|---|
| Price check | `Ctrl+D` | Hold `Ctrl`: the panel closes when you let go and move the mouse away, unless the mouse went into the panel |
| Price check, locked | `Ctrl+Alt+D` | The panel stays and takes the keyboard; click outside or press `Esc` to close |
| Item check | `Alt+D` | Item info with wiki, poedb and Craft of Exile links |
| Overlay key | `Shift+Space` | Switches the overlay between passive and active; with nothing shown it reopens the last price check |
| Close | `Esc` | Only while a panel is shown; otherwise `Esc` goes to the game |
| Chat: `/hideout` | `F5` | |
| Chat: `/exit` | `F9` | Omarchy's dictation also uses `F9` (see Troubleshooting) |
| Chat: `@last ty`, `/invite @last`, `/tradewith @last`, `/hideout @last` | none | Set a key in Settings, Chat |
| Stash search | none | Add searches and keys in Settings, Stash search |

All of them can be changed in the settings. While OmaExiled is stopped they
are plain keys again: the service switches them off when it stops, and if
OmaExiled hangs or is killed outside the service they switch themselves off
15 seconds later.

**Two more ways to open a price check**, both off by default, in Settings,
Price check. Both open a locked price check (like `Ctrl+Alt+D`) and only act
while the game is focused:

- **Also open on the game's own Ctrl+Alt+C**: the game's copy key
  (`Ctrl+Alt+C`, or `Ctrl` + your advanced-descriptions key + `C`) copies the
  item as usual and also opens the price check. The item stays on your
  clipboard.
- **Open on any copied item (clipboard watch)**: every item the game copies,
  however you copied it, opens a price check. An item copied without the
  advanced-descriptions key (plain `Ctrl+C`) lacks the mod details, so the
  price check may miss or misread mods.

**Bar icon.** Dim while OmaExiled is stopped, normal while it runs, accent
colored while Path of Exile 2 is open.

- Left click opens the menu: status and league, **Settings / League**,
  **Open in Browser** (the same UI in your browser), **Open config folder**,
  **Quit**. When OmaExiled is stopped the menu offers **Start OmaExiled**.
  Keys inside the menu: `S` `B` `C` `Q`, `j`/`k` or arrows and `Enter`, `Esc`.
- Right click opens the settings window (and starts OmaExiled first if it is
  stopped).

A fullscreen game covers the bar. To open the menu from a key instead, bind
`omarchy-shell shell toggle omaexiled` in your Hyprland bindings.

**Settings** open in a normal window from the bar. In game, press the overlay
key (`Shift+Space`) and click the cog: the same settings open as a panel
inside the overlay. Pick your league there first; the game language must
match the language setting.

## Path of Exile 2 settings

- **Display mode.** Still to be confirmed in game: start with *Windowed
  Fullscreen*. If `Ctrl+D` copies nothing or clicks on the panel go to the
  game, switch to *Windowed* and report it (see `docs/IN-GAME-TESTS.md`).
- **Confine mouse to window** must be **off**. With it on, the mouse cannot
  reach the price panel.
- Keep the "show advanced item descriptions" key on its default (`Alt`) unless
  you need to change it; OmaExiled reads it from the game's config to copy
  items with full mod text.

## Troubleshooting

```bash
omaexiled status          # service, bar widget and backend state
omaexiled logs            # follow the log (backend, overlay host)
omaexiled ctl status      # what the backend sees (game, overlay, hotkeys, league)
omaexiled ctl             # every control command
```

- **A hotkey does nothing.** Check that the game window is focused and that
  `omaexiled ctl status` shows the game. The log names every hotkey that
  another Hyprland bind also uses; Hyprland runs both. Known ones: `F9` is
  Omarchy's push-to-talk dictation when voxtype is installed (give `/exit`
  another key in Settings, Chat), and any personal bind on `Ctrl+Alt+D`.
- **The panel shows but clicks go to the game.** Turn off "Confine mouse to
  window" in the game, then try Windowed instead of Windowed Fullscreen.
- **Trade search fails with a captcha / Cloudflare page.** Open the in-app
  browser (`omaexiled ctl open-browser https://www.pathofexile.com/trade2`),
  pass the check or log in there, close it and search again.
- **No bar icon.** `omarchy plugin list | grep omaexiled`, then
  `omaexiled update-plugin` and
  `omarchy plugin enable omaexiled --section right --after omarchy.tray`. The
  shell log is `journalctl --user -t omarchy-shell | grep -i omaexiled`.
- **The game does not get `Ctrl+D`, `Esc`, ... while OmaExiled is down.** The
  keys come back by themselves within 15 seconds; `omaexiled disable-binds`
  gives them back right away.
- **Quit stays quit.** After **Quit** the service stays stopped until you
  click **Start OmaExiled**, run `systemctl --user start omaexiled`, or log in
  again.
- **Developer tools.** `omaexiled ctl devtools overlay` (or `settings`) opens
  Chromium DevTools for that page.

Files: settings in `~/.config/omaexiled/` (`config.json` is EE2's format),
runtime sockets in `$XDG_RUNTIME_DIR/omaexiled/`. The UI is served on
`http://127.0.0.1:8584`.

## Uninstall

```bash
omaexiled uninstall
```

Stops and removes the service (its hotkeys are switched off right away), the
bar widget and `~/.local/bin/omaexiled`.
Your settings in `~/.config/omaexiled/` stay; delete that folder to remove
them too. Then delete the checkout.

## Development

`make` builds, `make test` runs the renderer (vitest) and backend (`bun test`)
suites. `tools/fake-poe` is a fake game window for testing without PoE2;
`docs/IN-GAME-TESTS.md` is the checklist that needs the real game.
`DESIGN.md` explains the architecture and `docs/port-notes/` maps every EE2
subsystem the port uses.
