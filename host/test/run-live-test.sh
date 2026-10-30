#!/bin/bash
# Live test of omaexiled-host on the running Hyprland session, against
# tools/fake-poe (fullscreen XWayland "Path of Exile 2") and the mock backend.
#
#   host/test/run-live-test.sh            # overlay, input, keyboard, settings
#   NETWORK=1 host/test/run-live-test.sh  # + in-app browser on pathofexile.com
#
# Needs: built host (host/build/omaexiled-host) and fake-poe, bun, jq, grim,
# ydotool with its daemon (YDOTOOL_SOCKET). Takes the focused monitor for a
# minute; moves the pointer and types into its own windows only. Uses a
# throwaway profile (XDG_DATA_HOME / XDG_CACHE_HOME in a temp dir) and cleans
# up every process it starts. Screenshots stay in the printed temp dir.

set -uo pipefail

repo=$(cd "$(dirname "$(readlink -f "$0")")/../.." && pwd)
host_bin=$repo/host/build/omaexiled-host
fake_poe=$repo/tools/fake-poe/build/fake-poe
port=${PORT:-18584}
ctl=http://127.0.0.1:$port/ctl
tmp=$(mktemp -d /tmp/omaexiled-host-test.XXXXXX)
socket=${XDG_RUNTIME_DIR:-/run/user/$UID}/omaexiled-host-test/host.sock
export YDOTOOL_SOCKET=${YDOTOOL_SOCKET:-${XDG_RUNTIME_DIR:-/run/user/$UID}/.ydotool_socket}
panel='{"x":200,"y":150,"width":420,"height":300}'

pass=0 fail=0
ok() { echo "PASS $*"; pass=$((pass + 1)); }
bad() { echo "FAIL $*"; fail=$((fail + 1)); }
check() { # check <description> <command...>
  local what=$1; shift
  if "$@"; then ok "$what"; else bad "$what"; fi
}

mock_pid= poe_pid=
cleanup() {
  curl -s -X POST "$ctl/send" -d '{"type":"quit"}' >/dev/null 2>&1
  sleep 1.5
  [[ -n $mock_pid ]] && kill "$mock_pid" 2>/dev/null
  [[ -n $poe_pid ]] && kill "$poe_pid" 2>/dev/null
  rm -f "$socket"
  echo "results: $pass passed, $fail failed (logs and screenshots in $tmp)"
}
trap cleanup EXIT

send() { curl -s -X POST "$ctl/send" -d "$1" >/dev/null; }
reset() { curl -s -X POST "$ctl/reset" >/dev/null; }
received() { curl -s "$ctl/received?type=$1"; }
last_state() { received overlay.state | jq -c '.[-1].msg | [.mapped, .keyboardFocus]'; }
page_events() { curl -s "$ctl/page-events?type=$1&page=${2:-overlay}" | jq length; }
host_pid() { curl -s "$ctl/state" | jq -r .hostPid; }
our_layer() {
  hyprctl layers -j | jq -c --arg m "$mon" --argjson pid "$(host_pid)" \
    '[.[$m].levels["3"][]? | select(.namespace == "omaexiled" and .pid == $pid) | [.x, .y, .w, .h]]'
}
active_pid() { hyprctl activewindow -j | jq -r .pid; }
poe_log_has() { grep -q "$1" "$tmp/fake-poe.log"; }
clear_poe_log() { : >"$tmp/fake-poe.log"; }
# Warp, then real relative motion so clients get motion events there.
pointer() {
  hyprctl eval "hl.dispatch(hl.dsp.cursor.move({ x = $1, y = $2 }))" >/dev/null
  sleep 0.05
  ydotool mousemove -x 3 -y 3 >/dev/null
  sleep 0.05
  ydotool mousemove -x -3 -y -3 >/dev/null
  sleep 0.4
}
key() { ydotool key "$1:1" "$1:0" >/dev/null; sleep 0.4; } # evdev code, to the keyboard focus
compositor_key() {
  hyprctl dispatch "hl.dsp.send_key_state({ mods = \"\", key = \"$1\", state = \"down\" })" >/dev/null
  sleep 0.05
  hyprctl dispatch "hl.dsp.send_key_state({ mods = \"\", key = \"$1\", state = \"up\" })" >/dev/null
  sleep 0.4
}
wait_for() { # wait_for <seconds> <command...>
  local end=$((SECONDS + $1)); shift
  until "$@"; do ((SECONDS >= end)) && return 1; sleep 0.2; done
}
close_window() { # close_window <title>: like the user closing it
  local addr
  addr=$(hyprctl clients -j | jq -r --arg t "$1" '.[] | select(.title == $t) | .address')
  [[ -n $addr ]] && hyprctl dispatch "hl.dsp.window.close({ window = \"address:$addr\" })" >/dev/null
}
has_client() { [[ -n $(hyprctl clients -j | jq -r --arg t "$1" '.[] | select(.class == "omaexiled" and .title == $t) | .address') ]]; }

# Predicates for check / wait_for.
said_hello() { received hello | jq -e '.[0].msg.userAgent // "" | test("Chrome")' >/dev/null 2>&1; }
logged() { received log | jq -r '.[].msg.message' | grep -q -- "$1"; }
page_size_is() { curl -s "$ctl/state" | jq -e --argjson w "$1" --argjson h "$2" '.ticks.overlay.width == $w and .ticks.overlay.height == $h' >/dev/null; }
never_mapped() { [[ $(received overlay.state | jq '[.[].msg | select(.mapped)] | length') == 0 ]]; }
state_is() { [[ $(last_state) == "$1" ]]; }
mapped() { received overlay.state | jq -e '.[-1].msg.mapped' >/dev/null; }
focused() { received overlay.state | jq -e '.[-1].msg.keyboardFocus' >/dev/null; }
layer_is() { [[ $(our_layer) == "$1" ]]; }
game_active() { [[ $(active_pid) == "$poe_pid" ]]; }
no_poe_log() { ! grep -q -- "$1" "$tmp/fake-poe.log"; }
count_is() { [[ $(page_events "$1" "${3:-overlay}") == "$2" ]]; }
count_gt0() { (($(page_events "$1" "${2:-overlay}") > 0)); }
settings_mode() { curl -s "$ctl/page-events?type=loaded&page=settings" | jq -e '.[0].mode == "settings"' >/dev/null; }
closed_is() { received window.closed | jq -e --arg w "$1" '.[0].msg.window == $w' >/dev/null; }
poe_cookies() { received cookies | jq -e '[.[].msg.cookies[].domain | endswith("pathofexile.com")] | any' >/dev/null; }
host_gone() { ! kill -0 "$1" 2>/dev/null; }

for f in "$host_bin" "$fake_poe"; do [[ -x $f ]] || { echo "missing $f (build it first)"; exit 1; }; done

# Focused monitor, logical size.
read -r mon mw mh < <(hyprctl monitors -j | jq -r '.[] | select(.focused) |
  [.name, ((if .transform % 2 == 1 then .height else .width end) / .scale | floor),
          ((if .transform % 2 == 1 then .width else .height end) / .scale | floor)] | @tsv')
echo "monitor $mon ${mw}x${mh}, temp dir $tmp"
full="[[0,0,$mw,$mh]]"

FAKE_POE_LOG=$tmp/fake-poe.log "$fake_poe" --fullscreen >"$tmp/fake-poe.out" 2>&1 &
poe_pid=$!
XDG_DATA_HOME=$tmp/data XDG_CACHE_HOME=$tmp/cache \
  bun "$repo/host/test/mock-backend.ts" --port "$port" --socket "$socket" --spawn "$host_bin" \
  >"$tmp/mock.log" 2>&1 &
mock_pid=$!

check "host says hello with a user agent" wait_for 15 said_hello
check "overlay page preloaded" wait_for 15 logged "overlay page loaded"
renderer=$(received log | jq -r '.[].msg.message' | grep 'overlay page loaded' | tail -1 | sed 's/.*pid \([0-9]*\).*/\1/')
check "preloaded page has the monitor size while hidden (warm-up)" wait_for 5 page_size_is "$mw" "$mh"
check "warm-up left no surface and reported nothing" bash -c "[[ \$(hyprctl layers -j | jq '[.[].levels[\"3\"][]? | select(.pid == $(host_pid))] | length') == 0 ]]"
check "... and was never reported as mapped" never_mapped
hyprctl dispatch "hl.dsp.focus({ window = \"pid:$poe_pid\" })" >/dev/null
wait_for 5 game_active

# --- overlay map -----------------------------------------------------------
reset
send "{\"type\":\"overlay.show\",\"output\":\"$mon\",\"rect\":{\"x\":0,\"y\":0,\"width\":$mw,\"height\":$mh}}"
send "{\"type\":\"overlay.input\",\"rects\":[$panel],\"full\":false}"
check "overlay.state mapped" wait_for 5 mapped
check "layer 'omaexiled' on the overlay level covers $mon" layer_is "$full"
sleep 0.3
check "mapping did not take the keyboard from the game" bash -c "[[ $(active_pid) == $poe_pid && '$(last_state)' == '[true,false]' ]]"
grim "$tmp/overlay-panel.png"

# --- pointer and keyboard through the input region ---------------------------
clear_poe_log; pointer $((mw - 500)) $((mh - 300))
check "pointer outside the panel reaches the game" poe_log_has MOUSE_MOVE
check "keyboardFocus false outside the panel" state_is "[true,false]"
key 30
check "keys go to the game while the pointer is outside" poe_log_has "KEY key=A"

clear_poe_log; reset; pointer 400 300
check "pointer inside the panel does not reach the game" no_poe_log MOUSE_MOVE
check "overlay reports keyboardFocus over the panel" wait_for 3 focused
check "page saw the pointer enter the panel" count_gt0 panel-enter
key 48; compositor_key C
check "keys (ydotool and send_key_state) go to the panel" count_is keydown 2
check "... and not to the game" no_poe_log KEY

clear_poe_log; pointer $((mw - 500)) $((mh - 300)); key 32
check "pointer back over the game returns the keyboard" poe_log_has "KEY key=D"
check "... and keyboardFocus false" state_is "[true,false]"

send '{"type":"overlay.input","rects":[],"full":true}'; sleep 0.3
clear_poe_log; pointer $((mw - 400)) $((mh - 200))
check "full input region: nothing reaches the game" no_poe_log MOUSE_MOVE
send '{"type":"overlay.input","rects":[],"full":false}'; sleep 0.3
clear_poe_log; pointer 410 310
check "empty input region: the panel area is click-through" poe_log_has MOUSE_MOVE

# --- hide, windowed rect, crash ----------------------------------------------
send "{\"type\":\"overlay.input\",\"rects\":[$panel],\"full\":false}"; pointer 400 300
reset; send '{"type":"overlay.hide"}'; sleep 0.6
check "overlay.hide removes the layer" layer_is "[]"
check "... and reports unmapped" state_is "[false,false]"
clear_poe_log; key 30
check "after hide the game has the keyboard" poe_log_has "KEY key=A"

send "{\"type\":\"overlay.show\",\"output\":\"$mon\",\"rect\":{\"x\":100,\"y\":80,\"width\":1200,\"height\":700}}"; sleep 0.8
check "windowed game rect becomes the surface geometry" layer_is "[[100,80,1200,700]]"
send "{\"type\":\"overlay.show\",\"output\":\"$mon\",\"rect\":{\"x\":300,\"y\":200,\"width\":1000,\"height\":600}}"; sleep 0.6
check "a new rect while mapped moves the surface" layer_is "[[300,200,1000,600]]"
send '{"type":"overlay.show","output":"NO-SUCH-OUTPUT","rect":{"x":0,"y":0,"width":10,"height":10}}'; sleep 0.3
check "unknown output is logged" logged NO-SUCH-OUTPUT
check "... and the surface kept" layer_is "[[300,200,1000,600]]"
send '{"type":"overlay.hide"}'; sleep 0.5

reset
check "overlay renderer process killed" kill -9 "$renderer"
check "overlay page reloads after its renderer is killed" wait_for 15 logged "overlay page loaded"
check "reloaded page warmed up again (got its size while hidden)" wait_for 5 count_gt0 resize
check "... and stays unmapped" layer_is "[]"

# --- settings window -------------------------------------------------------------
reset; send '{"type":"settings.open"}'
check "settings.open shows a normal window 'OmaExiled Settings'" wait_for 10 has_client "OmaExiled Settings"
check "settings page loaded in settings mode" wait_for 10 settings_mode
grim "$tmp/settings.png"
close_window "OmaExiled Settings"
check "closing it reports window.closed" wait_for 3 closed_is settings
check "... and hides it" bash -c "! hyprctl clients -j | jq -e '.[] | select(.title == \"OmaExiled Settings\")' >/dev/null"
reset; send '{"type":"settings.open"}'
check "settings.open again shows it" wait_for 5 has_client "OmaExiled Settings"
check "... with a new page (a closed window is dropped)" wait_for 10 count_is loaded 1 settings
# The page's own window.close() (the renderer's Save / Cancel / X), on two
# opens in a row: QtWebEngine honours it only once per view.
for n in 1 2; do
  if [[ $n == 2 ]]; then
    reset; send '{"type":"settings.open"}'
    wait_for 10 count_is loaded 1 settings
  fi
  reset; key 1 # Escape: the test page calls window.close()
  check "page window.close() closes the window (open #$n)" wait_for 3 closed_is settings
  check "... and hides it" bash -c "! hyprctl clients -j | jq -e '.[] | select(.title == \"OmaExiled Settings\")' >/dev/null"
done
reset; send '{"type":"settings.open"}'; wait_for 10 has_client "OmaExiled Settings"
send '{"type":"settings.close"}'; sleep 0.5
check "backend settings.close hides it" bash -c "! hyprctl clients -j | jq -e '.[] | select(.title == \"OmaExiled Settings\")' >/dev/null"

# --- in-app browser (network) -----------------------------------------------------
if [[ ${NETWORK:-0} == 1 ]]; then
  reset; send '{"type":"browser.open","url":"https://www.pathofexile.com/trade2"}'
  check "browser window 'OmaExiled Browser'" wait_for 10 has_client "OmaExiled Browser"
  check "pathofexile.com cookies reach the backend" wait_for 40 poe_cookies
  grim "$tmp/browser.png"
  close_window "OmaExiled Browser"
  check "closing the browser reports window.closed" wait_for 3 closed_is browser
fi

# --- quit ---------------------------------------------------------------------
hp=$(host_pid)
send '{"type":"quit"}'
check "quit ends the host" wait_for 10 host_gone "$hp"
