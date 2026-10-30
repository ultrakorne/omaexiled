# In-game test checklist (draft)

Everything below needs the real Path of Exile 2. The rest was tested with
`tools/fake-poe`, a fake game window, which cannot answer two questions
(DESIGN.md "Verified platform behavior"): does the game (Wine/Proton) accept
the keys OmaExiled sends, and does it lock the mouse to its window. This list
answers those and checks every feature against the real client.

Run each test in **Windowed Fullscreen** first. Where a test says "both
modes", repeat it in **Windowed**. Write down the result of every test, also
the ones that pass (a filled table is at the end).

Already verified with `tools/fake-poe` (fullscreen) and the real backend,
host and renderer, with real key presses through the compositor: the copy
chord and item text, the panel on the overlay layer above the fullscreen
window with live trade results, pointer and keyboard moving between the
panel and the game, filter clicks, `Esc`, hold-mode auto-close, the locked
check, `F5`, stash search, `Shift+Space`, hotkeys passing through to other
windows, the settings window (save, font size applied to the next panel),
clipboard restore, host and backend restarts. So a failure below most likely
comes from the real client (Proton key handling, pointer confinement, the
display mode), which is what these tests are for.

## Before you start

1. Install and check the service:
   ```bash
   bin/omaexiled install
   omaexiled status                # service active, bar widget on the bar
   ```
2. In PoE2 options: turn **off** any "confine mouse to window" option, leave
   the "show advanced item descriptions" key on `Alt`, and set the display
   mode to **Windowed Fullscreen**.
3. Known hotkey conflicts on this machine (Hyprland runs every bind on a key,
   so both would fire). OmaExiled never edits your Hyprland config; fix these
   yourself before tests 8 and 10:
   - `Ctrl+Alt+D` is also bound by the old price-check script in
     `~/.config/hypr/bindings.lua` line 10
     (`o.bind("CTRL + ALT + D", "PoE2 price check", …poe-pricecheck.sh)`).
     Comment that line out, or give the locked price check another key in
     Settings, Price check.
   - `F9` is Omarchy's push-to-talk dictation (voxtype). Either accept that
     dictation starts too, or give `/exit` another key in Settings, Chat.
4. Keep a log running on another monitor, or check it after each test:
   ```bash
   omaexiled logs
   ```

**What to collect when a test fails** (paste it into the report):

```bash
journalctl --user -u omaexiled --since "-5 min" --no-pager > omaexiled.log
omaexiled ctl status > ctl-status.json
hyprctl clients -j | jq '.[] | select(.class == "steam_app_2694490")' > game-window.json
hyprctl layers -j > layers.json
grim ~/omaexiled-fail.png            # a screenshot, while the problem is visible
```

`game-window.json` shows the game's `fullscreen` value (0 = windowed,
2 = fullscreen), which matters for most of the tests below.

---

### 1. Hotkey reaches the game (copy works)

Steps:
1. In your hideout, open your stash or inventory and hover a rare item.
2. Press `Ctrl+D`.
3. Afterwards, paste (`Ctrl+V`) into a text editor outside the game.

Expected: the price panel appears next to the item within about a second,
showing the item's name and mods. If Settings, General, **Restore
clipboard** is on, your clipboard holds what it held before `Ctrl+D`;
with it off (EE2's default, and what an imported EE2 config usually has) it
holds the item text.

If it fails, report: nothing at all, a panel with "unknown item" / parse
error, or a panel for a *previous* item; the display mode; the log lines
around the key press (look for `copy`, `clipboard`, `send_shortcut`); whether
`Ctrl+Alt+C` pressed by hand in game puts the item text on the clipboard
(`wl-paste` in a terminal).

### 2. The panel appears above the game (both modes)

Steps:
1. Windowed Fullscreen: `Ctrl+D` on an item on the left half of the screen,
   then on one on the right half.
2. Switch the game to Windowed and repeat.

Expected: the panel is drawn on top of the game in both modes, on the side
opposite the item, never behind it, without flicker. In Windowed it stays
inside the game window. The first price check after the switch is placed
right too, as is the first one after moving the game to another monitor.

If it fails, report: mode, the game's `fullscreen` value, whether the panel
is missing, behind the game, offset, or on the wrong monitor; a screenshot;
`layers.json` (look for namespace `omaexiled`).

### 3. Mouse on the panel (filters, search, scroll, tooltips)

Steps:
1. `Ctrl+D` on a rare item, keep `Ctrl` held, move the mouse into the panel,
   release `Ctrl`.
2. Toggle a few mod filters, change a min/max value by typing, press
   **Search**.
3. Scroll the results list with the wheel.
4. Hold `Shift` while hovering a result or a filter to see its tooltip.

Expected: every click, typed value and scroll lands in the panel; tooltips
appear; the game does not react (no skill use, no item pickup) while the
mouse is over the panel.

If it fails, report: which action failed, whether the game reacted instead,
the mode, a screenshot.

### 4. Clicks outside the panel go to the game

Steps:
1. With a quick price check panel shown (`Ctrl+D`), click on the ground and on
   an inventory item next to the panel.

Expected: the game receives those clicks (character moves, item is picked
up) and the panel stays.

If it fails, report: whether clicks are swallowed, close the panel, or both;
the mode.

### 5. The keyboard goes back to the game

Steps:
1. `Ctrl+D`, move the mouse into the panel and type in a number field.
2. Move the mouse back over the game and press a skill key and the inventory
   key (`I`).

Expected: typing works in the panel while the mouse is over it; once the
mouse is back over the game, keys go to the game again without clicking.

If it fails, report: whether the panel kept the keyboard, the game never
lost it (typing went to the game), or keys were stuck (character keeps
moving); the mode.

### 6. Esc closes the panel

Steps:
1. Open a price check (`Ctrl+D`), press `Esc`.
2. With no panel shown, press `Esc`.

Expected: (1) the panel closes and the game does **not** open its own menu.
(2) the game's menu opens as usual.

If it fails, report: which case, what happened instead.

### 7. Hold mode closes by itself

Steps:
1. Hold `Ctrl`, press `D` over an item, release `Ctrl` and move the mouse a
   few centimeters away from the item without entering the panel.
2. Repeat, but move into the panel before releasing `Ctrl`, then release and
   move back out.

Expected: (1) the panel closes as soon as you release `Ctrl` and move away.
(2) the panel stays open (it was entered); it closes with `Esc` or the close
button. A click outside reaches the game and the panel stays (as in test 4).

If it fails, report: which case, whether it closed too early, never, or
only after a delay.

### 8. Locked price check (`Ctrl+Alt+D`)

Fix the `Ctrl+Alt+D` conflict first (see "Before you start").

Steps:
1. Hover an item and press `Ctrl+Alt+D`.
2. Type in the panel without moving the mouse into it.
3. Click on the dimmed area outside the panel.

Expected: the panel opens active: the rest of the screen is dimmed and a
click outside closes it (and does not reach the game). `Esc` closes it. The
keyboard moves to the panel once the mouse moves (the overlay takes the
keyboard on demand, like the quick check); keys pressed before you touch the
mouse still reach the game. That is how it behaves with the fake game, so
only report it if it hurts in practice.

If it fails, report: whether the old script also ran (a terminal or
notification from `poe-pricecheck.sh`), whether the background was dimmed,
where the keyboard went before and after moving the mouse.

### 9. Item check (`Alt+D`) and its links

Steps:
1. Hover an item and press `Alt+D`.
2. Click **wiki**, then **poedb**, then **CoE** (shown for craftable items).

Expected: the item check panel opens active. Each link opens in your default
browser; the game keeps running. The panel closes or stays as in EE2.

If it fails, report: whether the panel opened, whether the browser opened
(and on which workspace / monitor), whether focus came back to the game when
you returned to it.

### 10. Chat macros

Note: `/exit` sends you to character selection. Fix or accept the `F9`
dictation conflict first.

Steps:
1. In a zone, press `F5`.
2. Press `F9`.
3. Have someone whisper you (or whisper yourself from a second account). In
   Settings, Chat, give `@last ty`, `/invite @last`, `/tradewith @last` and
   `/hideout @last` keys, then press each one.

Expected: (1) the chat opens, `/hideout` is sent, the chat box closes again
and you go to your hideout. (2) you go to character selection. (3) each command is sent to the last person who
whispered you (check the chat log); `/invite` sends a party invite,
`/tradewith` opens a trade request.

If it fails, report: the text that appeared in the chat box (missing first
letters, wrong name, not sent), whether dictation started on `F9`.

### 11. Stash search

Steps:
1. In Settings, Stash search, add an entry (for example `"Waystone Tier"`)
   with a key.
2. Open your stash and press that key.

Expected: the stash search box gets the text and the stash highlights the
matching items.

If it fails, report: whether the search box opened, whether the text was
pasted, whether your clipboard was restored afterwards (only expected with
Settings, General, **Restore clipboard** on).

### 12. Overlay key (`Shift+Space`)

Steps:
1. Open a quick price check (`Ctrl+D`), then press `Shift+Space`.
2. Press `Shift+Space` again.
3. Close the panel, then press `Shift+Space` with nothing shown.

Expected: (1) the panel becomes active (dimmed background); the keyboard
moves to the panel once the mouse moves (as in test 8). (2) back to passive.
(3) the last price check reopens.

If it fails, report: what happened at each step, whether the game also got
`Shift+Space`.

### 13. Settings from the bar and from the game

Steps:
1. With the game running, open the settings with the bar icon (left click,
   **Settings / League**, or right click). In fullscreen the bar is hidden:
   use another monitor, `Super+Tab` out, or run
   `omarchy-shell shell toggle omaexiled` from a key binding.
2. In game, press `Shift+Space` and click the cog icon.
3. Each time, change the font size and close the settings.

Expected: (1) opens the settings as a normal window you can type in. (2)
opens the same settings as a panel inside the overlay, above the game (not a
separate window). In both, **Save** applies the change to the next price
check and closes the settings; **Cancel** and the X (for the window also
closing it with the compositor) drop unsaved changes. Open and close the
window a few times in a row: every close must work. Closing the window
returns you to the game.

If it fails, report: which way failed, where the window or panel appeared
(behind the game, other workspace), whether you could type in it.

### 14. League switching

Steps:
1. In Settings, pick a different league and close the settings.
2. Open the bar menu.
3. Price check an item.

Expected: the bar menu shows the new league; the price check searches that
league (the trade link in the panel points to it).

If it fails, report: old/new league, what the bar showed, the league in the
trade link.

### 15. Focus loss and Alt+Tab

Steps:
1. Open a price check, then switch to another window (`Super+Tab`, a
   workspace key, or click on another monitor).
2. In that other window press `Ctrl+D`, `Alt+D`, `F5`, `Esc`.
3. Switch back to the game and move your character.

Expected: the panel hides when the game loses focus. In the other window the
keys do what they normally do there (OmaExiled ignores them). Back in the
game, no key is stuck and hotkeys work again.

If it fails, report: whether the panel stayed above other windows, which key
was taken from the other window, any stuck key.

### 16. PoE2 restart

Steps:
1. Quit the game while OmaExiled keeps running. Check the bar icon.
2. Start the game again and price check an item.

Expected: the icon loses its accent color when the game closes and gets it
back when it starts. The first price check after the restart works without
touching OmaExiled.

If it fails, report: the icon state, what the first `Ctrl+D` did, the log.

### 17. OmaExiled restart while the game runs

Steps:
1. With the game focused, run `systemctl --user restart omaexiled` (from
   another monitor or with a terminal bind), wait 5 seconds, price check.
2. Bar menu, **Quit**. In game press `Ctrl+D` and `Esc`.
3. Bar menu, **Start OmaExiled**, wait 5 seconds, price check.
4. `systemctl --user kill -s KILL omaexiled` (a crash); press `Ctrl+D` and
   `Esc` right away and again after 5 seconds.
5. A hung OmaExiled: `systemctl --user kill -s STOP --kill-whom=main
   omaexiled`, wait 20 seconds, press `Ctrl+D` and `Esc` in game. Then
   `systemctl --user kill -s CONT --kill-whom=main omaexiled`, wait 10
   seconds, price check.

Expected: (1) and (3) price checks work again. (2) while OmaExiled is
stopped, `Ctrl+D` and `Esc` behave like plain keys in the game. (4) right
after the kill `Ctrl+D` and `Esc` are plain keys (the service switches the
hotkeys off when the backend dies, `omaexiled logs` shows "Hotkeys switched
off in Hyprland"); the service restarts by itself within a few seconds and
price checks work again. (5) for up to 15 seconds after the STOP the hotkeys
do nothing; after 20 seconds they are plain keys again (the game gets
`Ctrl+D`, `Esc` opens its menu). After CONT price checks work again.

If it fails, report: the step, whether keys were swallowed while OmaExiled
was down (and for how long), `omaexiled status`, the log.

### 18. Other workspaces and monitors stay untouched

Steps:
1. Open a price check, then switch to another workspace that has a browser
   or terminal.
2. Click and type everywhere on that workspace (and on other monitors),
   including where the panel was.
3. With the game on a workspace that is not shown, press `Ctrl+D` in another
   app.

Expected: nothing from OmaExiled is visible or clickable outside the game's
workspace; all clicks and keys reach the apps there; no panel pops up for
step 3.

If it fails, report: where input was captured or the panel was visible, a
screenshot.

### 19. Performance

Steps:
1. Turn on an FPS display (PoE2's own, or run the game with MangoHud).
2. Note the FPS standing in your hideout with no panel, then with a price
   check panel open, then while moving the mouse over the panel.
3. Open and close the panel quickly several times while moving.

Expected: no noticeable FPS drop or stutter while the panel is shown; no
tearing or black frames when it opens or closes; the game returns to its
normal FPS when the panel closes.

If it fails, report: the FPS numbers for each case, the mode, whether VRR is
on, a short screen recording if possible.

### 20. Pointer confinement

Steps:
1. Turn **on** PoE2's "confine mouse to window" (or similarly named) option,
   restart the game if it asks.
2. Price check an item and try to click a filter in the panel (test 3).
3. Turn the option off again.

Expected: with the option off everything works (tests 3 to 5). With it on
the panel may not get the mouse at all; that is the reason the README says to
keep it off.

If it fails, report: the exact name of the option, whether the panel got
mouse input with it on, whether anything broke with it off.

### 21. Price check on the game's own copy key

Steps:
1. In Settings, Price check, turn on **Also open on the game's own
   Ctrl+Alt+C** and save.
2. Hover an item and press `Ctrl+Alt+C` yourself. Then paste (`Ctrl+V`) into a
   text editor outside the game.
3. Back in game, press `Ctrl+Alt+C` on a second item, then `Ctrl+D` on a third.
4. Turn the option off again, save, and press `Ctrl+Alt+C` on an item.

Expected: (2) a locked price check opens for the item (dimmed background,
like `Ctrl+Alt+D`) and the pasted text is the item with its advanced mod
descriptions: the game got the key and copied as usual. (3) each key opens
one panel for its own item. (4) the game copies, no panel opens.

If it fails, report: whether the panel opened, whether the game still copied
(the pasted text), the log lines around the key press (look for `game-copy`,
`ClipboardPoller`).

### 22. Clipboard watch

Steps:
1. In Settings, Price check, turn on **Open on any copied item (clipboard
   watch)** and save.
2. Hover an item and press `Ctrl+Alt+C`. Close the panel, then press `Ctrl+C`
   on another item.
3. Press `Ctrl+D` on an item.
4. Switch to another window (`Super+Tab`), copy any text there, switch back
   to the game.
5. Turn the option off again, save, and press `Ctrl+Alt+C` on an item.

Expected: (2) each copy opens a locked price check for that item; the one
copied with plain `Ctrl+C` shows fewer mod details (expected, the setting's
hint says so). (3) exactly one panel, as without the watch. (4) nothing
happens while the other window is focused, nor when you switch back. (5) the
game copies, no panel opens.

If it fails, report: which step, whether a panel opened twice or for the
wrong item, the log lines around the copy (look for `ClipboardWatch`).

---

## Results

| # | Test | Windowed Fullscreen | Windowed | Notes |
|---|---|---|---|---|
| 1 | Copy reaches the game | | | |
| 2 | Panel above the game | | | |
| 3 | Mouse on the panel | | | |
| 4 | Clicks outside go to the game | | | |
| 5 | Keyboard back to the game | | | |
| 6 | Esc | | | |
| 7 | Hold mode | | | |
| 8 | Locked price check | | | |
| 9 | Item check and links | | | |
| 10 | Chat macros | | | |
| 11 | Stash search | | | |
| 12 | Overlay key | | | |
| 13 | Settings | | | |
| 14 | League switching | | | |
| 15 | Focus loss | | | |
| 16 | PoE2 restart | | | |
| 17 | OmaExiled restart | | | |
| 18 | Other workspaces | | | |
| 19 | Performance | | | |
| 20 | Pointer confinement | | | |
| 21 | Game copy key | | | |
| 22 | Clipboard watch | | | |

Also note: GPU and driver, monitor setup (resolution, scale, refresh), the
display mode you settled on, and the output of `omaexiled status`.
