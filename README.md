# OmaExiled

Path of Exile 2 price checker for [Omarchy](https://omarchy.org). It is a native* Wayland port of the price-check
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


## Credits

- [Exiled Exchange 2](https://github.com/Kvan7/Exiled-Exchange-2) by Kvan7
  (MIT). OmaExiled's renderer is EE2's Vue app.
- [Awakened PoE Trade](https://github.com/SnosMe/awakened-poe-trade) by
  SnosMe (MIT), which EE2 is a fork of.

OmaExiled is MIT licensed as well (see `LICENSE`); the code taken from EE2
keeps its original MIT notice in `renderer/LICENSE`. It is not affiliated
with or endorsed by Grinding Gear Games.

## Requirements

Omarchy with Hyprland 0.56 or newer, plus:

```bash
sudo pacman -S --needed layer-shell-qt qt6-webengine bun nodejs npm base-devel
```

`layer-shell-qt` is the one package a fresh Omarchy never has. 

## Install

```bash
git clone https://github.com/ultrakorne/omaexiled.git ~/Developer/OmaExiled
~/Developer/OmaExiled/bin/omaexiled install
```

`install` builds everything (`make`), installs and starts the
`omaexiled.service` systemd user unit, links `~/.local/bin/omaexiled`, copies
the bar widget to `~/.config/omarchy/plugins/omaexiled/` and puts it on the
right side of the bar. It is safe to run again after `git pull`: it rebuilds,
updates what changed and restarts the service.

The service does **not** start at login: start it when you play, from the bar
widget (**Start OmaExiled**) or with `omaexiled start`, and stop it with
**Quit** or `omaexiled stop`. To start it with every graphical session instead,
install with `omaexiled install --autostart`. On first start, settings from
an Exiled Exchange 2 install (`~/.config/exiled-exchange-2/apt-data/config.json`)
are imported once.

## Usage

Hover an item in game and press a hotkey:

| Action | Default | Notes |
|---|---|---|
| Price check | `Ctrl+D` | Hold `Ctrl`: the panel closes when you let go and move the mouse away, unless the mouse went into the panel |
| Price check, locked | `Ctrl+Alt+D` | The panel stays and takes the keyboard; click outside or press `Esc` to close |
| Item check | `Alt+D` | Item info with wiki, poedb and Craft of Exile links |
| Overlay key | `Shift+Space` | Switches the overlay between passive and active (shows the menu, as in EE2) |
| Close | `Esc` | Only while a panel is shown; otherwise `Esc` goes to the game |
| Chat: `/hideout` | `F5` | |
| Chat: `/exit` | `F9` | Omarchy's dictation also uses `F9` (see Troubleshooting) |
| Chat: `@last ty`, `/invite @last`, `/tradewith @last`, `/hideout @last` | none | Set a key in Settings, Chat |
| Stash search | none | Add searches and keys in Settings, Stash search |


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

- **Display mode.** *Windowed Fullscreen* (borderless, full screen) is tested
  and works. 
- **Confine mouse to window** can stay off; OmaExiled already copes with the
  confinement Wine applies (see `docs/GOTCHAS.md`).
- Keep the "show advanced item descriptions" key on its default (`Alt`) unless
  you need to change it; OmaExiled reads it from the game's config to copy
  items with full mod text.

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
