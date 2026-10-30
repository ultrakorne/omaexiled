import { describe, expect, test } from "bun:test";
import type { IpcEvent } from "../../ipc/types";
import type { HyprClient, HyprMonitor, Hyprland } from "../src/hyprland";
import { monitorLogicalRect } from "../src/hyprland";
import { Logger } from "../src/logger";
import { OverlayState } from "../src/overlay-state";

const monitor = (over: Partial<HyprMonitor> = {}): HyprMonitor => ({
  id: 0,
  name: "DP-1",
  width: 2560,
  height: 1440,
  x: 0,
  y: 0,
  scale: 1,
  transform: 0,
  focused: true,
  activeWorkspace: { id: 4, name: "4" },
  specialWorkspace: { id: 0, name: "" },
  ...over,
});

const client = (over: Partial<HyprClient> = {}): HyprClient => ({
  address: "0xgame",
  mapped: true,
  hidden: false,
  at: [12, 38],
  size: [2536, 1390],
  workspace: { id: 4, name: "4" },
  floating: false,
  monitor: 0,
  class: "steam_app_2694490",
  title: "Path of Exile 2",
  pid: 1,
  xwayland: true,
  fullscreen: 0,
  ...over,
});

function setup() {
  const world = {
    clients: [client()] as HyprClient[],
    monitors: [monitor()] as HyprMonitor[],
    active: null as HyprClient | null,
    cursor: { x: 1000, y: 500 },
    // hl.is_key_down: "missing" = error reply (older Hyprland), "throw" =
    // request failure (timeout), "ok" = works
    keys: "missing" as "missing" | "throw" | "ok",
    ctrl: false,
    hostConnected: true,
  };
  world.active = world.clients[0];
  const hypr = {
    available: true,
    clients: async () => world.clients,
    monitors: async () => world.monitors,
    activeWindow: async () => world.active,
    cursorPos: async () => world.cursor,
    repl: async () => {
      if (world.keys === "throw") throw new Error("Hyprland request timed out");
      if (world.keys === "missing") return "error: attempt to call a nil value (field 'is_key_down')";
      return `${world.cursor.x}\t${world.cursor.y}\t${world.ctrl}\tfalse`;
    },
  } as unknown as Hyprland;
  const events: IpcEvent[] = [];
  const hostMsgs: any[] = [];
  const panel: boolean[] = [];
  const presence: boolean[] = [];
  const logger = new Logger();
  logger.write = () => {};
  const overlay = new OverlayState({
    hypr,
    logger,
    broadcast: (e) => events.push(e),
    sendItemText: (p) => events.push({ name: "MAIN->CLIENT::item-text", payload: p }),
    host: {
      get connected() {
        return world.hostConnected;
      },
      send: (m) => (hostMsgs.push(m), true),
    },
    setPanel: (v) => panel.push(v),
    onChange: () => {},
    onGamePresence: (p) => presence.push(p),
  });
  const focusChanges = () =>
    events.filter((e) => e.name === "MAIN->OVERLAY::focus-change").map((e) => (e as any).payload);
  const hides = () => events.filter((e) => e.name === "MAIN->OVERLAY::hide-exclusive-widget").length;
  // surface commands, without the warm-up geometry (tested on its own)
  const surface = () => hostMsgs.filter((m) => m.type !== "overlay.prepare");
  return { world, overlay, events, hostMsgs, panel, presence, focusChanges, hides, surface };
}

const settle = () => Bun.sleep(10);

describe("geometry", () => {
  test("monitor logical size: scale and transform", () => {
    expect(monitorLogicalRect(monitor({ scale: 1.5 }))).toEqual({ x: 0, y: 0, width: 1707, height: 960 });
    expect(monitorLogicalRect(monitor({ transform: 1 }))).toEqual({ x: 0, y: 0, width: 1440, height: 2560 });
    expect(monitorLogicalRect(monitor({ transform: 3, scale: 2, x: 2560 }))).toEqual({ x: 2560, y: 0, width: 720, height: 1280 });
    expect(monitorLogicalRect(monitor({ transform: 2 }))).toEqual({ x: 0, y: 0, width: 2560, height: 1440 });
  });

  test("surface covers the game window, monitor-local, clamped", async () => {
    const { world, overlay } = setup();
    await overlay.refresh();
    expect(overlay.computeGeometry()).toEqual({
      output: "DP-1",
      rect: { x: 12, y: 38, width: 2536, height: 1390 },
      origin: { x: 12, y: 38 },
    });
    // second monitor at x=2560, scale 2; window hanging over the right edge
    world.monitors.push(monitor({ id: 1, name: "HDMI-A-1", x: 2560, scale: 2, width: 3840, height: 2160 }));
    world.clients[0] = client({ monitor: 1, at: [2600, 100], size: [2000, 900] });
    world.active = world.clients[0];
    await overlay.refresh();
    expect(overlay.computeGeometry()).toEqual({
      output: "HDMI-A-1",
      rect: { x: 40, y: 100, width: 1880, height: 900 },
      origin: { x: 2600, y: 100 },
    });
  });

  test("item-text position is relative to the surface", async () => {
    const { overlay } = setup();
    await overlay.refresh();
    expect(await overlay.cursorInSurface()).toEqual({ x: 988, y: 462 });
  });

  test("without a game: the monitor under the cursor", async () => {
    const { world, overlay } = setup();
    world.clients = [];
    world.active = null;
    world.monitors.push(monitor({ id: 1, name: "HDMI-A-1", x: 2560, focused: false }));
    world.cursor = { x: 3000, y: 10 };
    await overlay.refresh();
    expect(await overlay.cursorInSurface()).toEqual({ x: 440, y: 10 });
    expect(overlay.computeGeometry()!.output).toBe("HDMI-A-1");
  });
});

describe("focus model (EE2 OverlayWindow)", () => {
  test("game focus and blur", async () => {
    const { world, overlay, focusChanges, presence } = setup();
    await overlay.refresh();
    expect(presence).toEqual([true]);
    expect(overlay.gameFocused).toBe(true);
    overlay.handleEvent("activewindow", "firefox,Some page");
    expect(overlay.gameFocused).toBe(false);
    overlay.handleEvent("activewindow", "steam_app_2694490,Path of Exile 2");
    expect(focusChanges()).toEqual([
      { game: true, overlay: false, usingHotkey: false },
      { game: false, overlay: false, usingHotkey: false },
      { game: true, overlay: false, usingHotkey: false },
    ]);
    world.clients = [];
    world.active = null;
    await overlay.refresh();
    expect(presence).toEqual([true, false]);
  });

  test("custom window title", async () => {
    const { world, overlay } = setup();
    world.clients = [client({ class: "wine", title: "PoE2 (beta)" })];
    world.active = world.clients[0];
    overlay.setWindowTitle("PoE2 (beta)");
    await overlay.refresh();
    expect(overlay.gameFocused).toBe(true);
  });

  test("active / inactive and the overlay key", async () => {
    const { overlay, focusChanges } = setup();
    await overlay.refresh();
    overlay.assertOverlayActive();
    overlay.assertOverlayActive(); // no-op
    overlay.assertGameActive();
    overlay.toggleActiveState();
    expect(focusChanges().slice(1)).toEqual([
      { game: false, overlay: true, usingHotkey: false },
      { game: true, overlay: false, usingHotkey: false },
      { game: false, overlay: true, usingHotkey: true },
    ]);
    // the game losing focus ends the active mode
    overlay.handleEvent("activewindow", "firefox,x");
    expect(overlay.overlayActive).toBe(false);
    expect(focusChanges().at(-1)).toEqual({ game: false, overlay: false, usingHotkey: false });
  });

  test("overlay key with nothing shown re-opens the last price check, active", async () => {
    const { overlay, events } = setup();
    await overlay.refresh();
    overlay.toggleOverlay(); // nothing to re-open: just activates
    expect(overlay.overlayActive).toBe(true);
    overlay.toggleOverlay();
    overlay.sendItemText({ target: "price-check", clipboard: "Item Class: X", position: { x: 1, y: 2 }, focusOverlay: false });
    overlay.toggleOverlay();
    const texts = events.filter((e) => e.name === "MAIN->CLIENT::item-text").map((e) => (e as any).payload);
    expect(texts.at(-1)).toEqual({ target: "price-check", clipboard: "Item Class: X", position: { x: 1, y: 2 }, focusOverlay: true });
    expect(overlay.overlayActive).toBe(true);
  });

  test("Escape / ctl hide", async () => {
    const { overlay, events } = setup();
    await overlay.refresh();
    overlay.assertOverlayActive();
    overlay.closePanel();
    expect(events.at(-2)!.name).toBe("MAIN->OVERLAY::hide-exclusive-widget");
    expect(overlay.overlayActive).toBe(false);
  });
});

describe("host surface", () => {
  test("render-state maps and unmaps over the game; input region follows", async () => {
    const { overlay, surface, panel } = setup();
    await overlay.refresh();
    overlay.onRenderState(true);
    overlay.onInputRegion({ rects: [{ x: 1, y: 2, width: 3, height: 4 }], full: false });
    await settle();
    expect(surface()).toEqual([
      { type: "overlay.show", output: "DP-1", rect: { x: 12, y: 38, width: 2536, height: 1390 } },
      { type: "overlay.input", rects: [{ x: 1, y: 2, width: 3, height: 4 }], full: false },
    ]);
    overlay.onInputRegion({ rects: [], full: true });
    overlay.onRenderState(false);
    await settle();
    expect(surface().slice(2)).toEqual([{ type: "overlay.input", rects: [], full: true }, { type: "overlay.hide" }]);
    expect(panel).toEqual([true, false]);
  });

  test("game blur closes a quick panel; it does not come back on focus", async () => {
    const { overlay, surface, hides } = setup();
    await overlay.refresh();
    overlay.onRenderState(true);
    overlay.onInputRegion({ rects: [{ x: 1, y: 2, width: 3, height: 4 }], full: false });
    await settle();
    expect(hides()).toBe(0);
    overlay.handleEvent("activewindow", "firefox,x");
    await settle();
    expect(surface().at(-1)).toEqual({ type: "overlay.hide" });
    expect(hides()).toBe(1);
    // the page hides the price check
    overlay.onRenderState(false);
    overlay.onInputRegion({ rects: [], full: false });
    const before = surface().length;
    overlay.handleEvent("activewindow", "steam_app_2694490,Path of Exile 2");
    await settle();
    expect(surface().length).toBe(before);
    // a blur with nothing shown sends nothing
    overlay.handleEvent("activewindow", "firefox,x");
    expect(hides()).toBe(1);
  });

  test("PoE2 closing under a visible panel unmaps it and clears the Escape gate", async () => {
    const { world, overlay, surface, panel, hides, focusChanges } = setup();
    await overlay.refresh();
    overlay.onRenderState(true);
    overlay.onInputRegion({ rects: [{ x: 1, y: 2, width: 3, height: 4 }], full: false });
    await settle();
    expect(panel).toEqual([true]);
    // the game was the only window on its workspace: closewindow, then an
    // empty activewindow
    world.clients = [];
    world.active = null;
    overlay.handleEvent("closewindow", "game");
    overlay.handleEvent("activewindow", ",");
    await Bun.sleep(200);
    expect(overlay.game).toBeNull();
    expect(surface().at(-1)).toEqual({ type: "overlay.hide" });
    expect(overlay.shown).toBeNull();
    expect(panel).toEqual([true, false]);
    expect(hides()).toBeGreaterThan(0); // the page drops the panel
    expect(focusChanges().at(-1)).toEqual({ game: false, overlay: false, usingHotkey: false });
    // stays unmapped while the page still reports something to show
    overlay.onInputRegion({ rects: [{ x: 1, y: 2, width: 3, height: 4 }], full: false });
    overlay.onRenderState(true);
    await settle();
    expect(overlay.shown).toBeNull();
    // a price check without the game (ctl, browser use) maps it again
    overlay.sendItemText({ target: "price-check", clipboard: "Item Class: X", position: { x: 1, y: 2 }, focusOverlay: false });
    overlay.onRenderState(true);
    await settle();
    expect(surface().at(-2)).toEqual({
      type: "overlay.show",
      output: "DP-1",
      rect: { x: 0, y: 0, width: 2560, height: 1440 },
    });
  });

  test("PoE2 closing in the active mode ends it", async () => {
    const { world, overlay, surface, focusChanges } = setup();
    await overlay.refresh();
    overlay.assertOverlayActive();
    await settle();
    expect(surface()[0].type).toBe("overlay.show");
    world.clients = [];
    world.active = null;
    await overlay.refresh();
    await settle();
    expect(overlay.overlayActive).toBe(false);
    expect(surface().at(-1)).toEqual({ type: "overlay.hide" });
    expect(focusChanges().at(-1)).toMatchObject({ overlay: false });
  });

  test("the Escape gate follows visible panels, not the mapped surface", async () => {
    const { overlay, panel } = setup();
    await overlay.refresh();
    // debug key log: mapped, nothing interactive
    overlay.onRenderState(true);
    overlay.onInputRegion({ rects: [], full: false });
    await settle();
    expect(overlay.shown).not.toBeNull();
    expect(panel).toEqual([]);
    overlay.onInputRegion({ rects: [{ x: 1, y: 2, width: 3, height: 4 }], full: false });
    expect(panel).toEqual([true]);
    overlay.onInputRegion({ rects: [], full: false });
    expect(panel).toEqual([true, false]);
    overlay.assertOverlayActive();
    await settle();
    expect(panel).toEqual([true, false, true]);
    overlay.assertGameActive();
    await settle();
    expect(panel).toEqual([true, false, true, false]);
  });

  test("host gone with a panel up: the Escape gate is cleared", async () => {
    const { world, overlay, panel } = setup();
    await overlay.refresh();
    overlay.onRenderState(true);
    overlay.onInputRegion({ rects: [{ x: 1, y: 2, width: 3, height: 4 }], full: false });
    await settle();
    expect(panel).toEqual([true]);
    world.hostConnected = false;
    overlay.onHostConnected();
    await settle();
    expect(overlay.shown).toBeNull();
    expect(panel).toEqual([true, false]);
  });

  test("an empty activewindow while our panel holds the keyboard keeps the game focused", async () => {
    const { world, overlay, focusChanges } = setup();
    await overlay.refresh();
    overlay.onRenderState(true);
    await settle();
    world.active = null; // layer surface took the keyboard
    overlay.handleEvent("activewindow", ",");
    await Bun.sleep(200);
    expect(overlay.gameFocused).toBe(true);
    expect(focusChanges()).toHaveLength(1);
    // but switching to an empty workspace is a blur
    world.monitors[0].activeWorkspace = { id: 9, name: "9" };
    overlay.handleEvent("activewindow", ",");
    await Bun.sleep(200);
    expect(overlay.gameFocused).toBe(false);
  });

  test("an empty activewindow without our panel is a blur", async () => {
    const { world, overlay } = setup();
    await overlay.refresh();
    world.active = null;
    overlay.handleEvent("activewindow", ",");
    expect(overlay.gameFocused).toBe(true); // debounced
    await Bun.sleep(200);
    expect(overlay.gameFocused).toBe(false);
  });
});

describe("overlay.prepare (warm-up geometry)", () => {
  const prepares = (msgs: any[]) => msgs.filter((m) => m.type === "overlay.prepare");
  const GAME = { type: "overlay.prepare", output: "DP-1", rect: { x: 12, y: 38, width: 2536, height: 1390 } };

  test("sent on host connect and when the hidden game window moves", async () => {
    const { world, overlay, hostMsgs } = setup();
    world.hostConnected = false;
    await overlay.refresh();
    expect(hostMsgs).toEqual([]);
    world.hostConnected = true;
    overlay.onHostConnected();
    await settle();
    expect(hostMsgs).toEqual([GAME]);
    // same geometry: nothing new
    await overlay.refresh();
    await settle();
    expect(hostMsgs).toHaveLength(1);
    // the game goes fullscreen
    world.clients[0] = client({ at: [0, 0], size: [2560, 1440], fullscreen: 1 });
    world.active = world.clients[0];
    overlay.handleEvent("fullscreen", "1");
    await Bun.sleep(80);
    expect(prepares(hostMsgs).at(-1)).toEqual({ ...GAME, rect: { x: 0, y: 0, width: 2560, height: 1440 } });
    // a host restart gets it again
    overlay.onHostConnected();
    await settle();
    expect(prepares(hostMsgs)).toHaveLength(3);
    // the game closing does not warm the page up for the desktop
    const game = world.clients[0];
    world.clients = [];
    world.active = null;
    await overlay.refresh();
    await settle();
    expect(prepares(hostMsgs)).toHaveLength(3);
    // a new game window: its geometry
    world.clients = [{ ...game, at: [12, 38], size: [2536, 1390] }];
    world.active = world.clients[0];
    await overlay.refresh();
    expect(prepares(hostMsgs)).toHaveLength(4);
    expect(prepares(hostMsgs).at(-1)).toEqual(GAME);
  });

  test("without a game: the monitor, on host connect only", async () => {
    const { world, overlay, hostMsgs } = setup();
    world.clients = [];
    world.active = null;
    await overlay.refresh();
    expect(hostMsgs).toEqual([
      { type: "overlay.prepare", output: "DP-1", rect: { x: 0, y: 0, width: 2560, height: 1440 } },
    ]);
  });

  test("not sent while shown; sent after hiding when the geometry changed meanwhile", async () => {
    const { world, overlay, hostMsgs } = setup();
    await overlay.refresh();
    expect(hostMsgs).toEqual([GAME]);
    overlay.onRenderState(true);
    await settle();
    world.clients[0] = client({ at: [100, 100], size: [1280, 720] });
    world.active = world.clients[0];
    await overlay.refresh();
    await settle();
    const moved = { output: "DP-1", rect: { x: 100, y: 100, width: 1280, height: 720 } };
    expect(prepares(hostMsgs)).toHaveLength(1);
    expect(hostMsgs.filter((m) => m.type === "overlay.show").at(-1)).toEqual({ type: "overlay.show", ...moved });
    overlay.onRenderState(false);
    await settle();
    // the host already has this geometry from overlay.show
    expect(prepares(hostMsgs)).toHaveLength(1);
    world.clients[0] = client({ at: [200, 100], size: [1280, 720] });
    world.active = world.clients[0];
    await overlay.refresh();
    expect(prepares(hostMsgs).at(-1)).toEqual({ type: "overlay.prepare", output: "DP-1", rect: { x: 200, y: 100, width: 1280, height: 720 } });
  });
});

describe("hold-mode tracker (EE2 WidgetAreaTracker)", () => {
  const from = { x: 988, y: 462 };
  const track = (overlay: OverlayState, area: { x: number; y: number; width: number; height: number }) =>
    overlay.onTrackArea({ holdKey: "Ctrl", closeThreshold: 40, from, area, dpr: 1 });

  test("released hold key + moved away closes; entering the panel stops", async () => {
    const { world, overlay, events } = setup();
    world.keys = "ok";
    await overlay.refresh();

    track(overlay, { x: 2000, y: 0, width: 400, height: 1390 });
    world.cursor = { x: 1010, y: 500 }; // 22 px: inside the threshold
    await Bun.sleep(120);
    expect(overlay.tracker.active).toBe(true);
    world.cursor = { x: 1100, y: 500 };
    await Bun.sleep(120);
    expect(overlay.tracker.active).toBe(false);
    expect(events.at(-1)!.name).toBe("MAIN->OVERLAY::hide-exclusive-widget");

    const before = events.length;
    track(overlay, { x: 1050, y: 0, width: 400, height: 1390 });
    world.cursor = { x: 1200, y: 500 }; // surface x 1188: inside the area
    await Bun.sleep(120);
    expect(overlay.tracker.active).toBe(false);
    expect(events.length).toBe(before);
  });

  test("held hold key keeps the panel; releasing it closes", async () => {
    const { world, overlay, hides } = setup();
    world.keys = "ok";
    world.ctrl = true;
    await overlay.refresh();
    track(overlay, { x: 2000, y: 0, width: 400, height: 1390 });
    world.cursor = { x: 1500, y: 500 };
    await Bun.sleep(150);
    expect(overlay.tracker.active).toBe(true);
    world.ctrl = false;
    await Bun.sleep(120);
    expect(overlay.tracker.active).toBe(false);
    expect(hides()).toBe(1);
  });

  test("without hl.is_key_down: the hold key counts as released", async () => {
    const { world, overlay, hides } = setup();
    world.keys = "missing";
    world.ctrl = true;
    await overlay.refresh();
    track(overlay, { x: 2000, y: 0, width: 400, height: 1390 });
    world.cursor = { x: 1100, y: 500 };
    await Bun.sleep(300);
    expect(overlay.tracker.active).toBe(false);
    expect(hides()).toBe(1);
  });

  test("a failed key-state request does not disable hold detection", async () => {
    const { world, overlay, hides } = setup();
    world.ctrl = true;
    await overlay.refresh();
    world.keys = "throw"; // Hyprland stalls during the check
    track(overlay, { x: 2000, y: 0, width: 400, height: 1390 });
    world.cursor = { x: 1500, y: 500 };
    await Bun.sleep(150);
    expect(overlay.tracker.active).toBe(true);
    expect(hides()).toBe(0);
    world.keys = "ok";
    await Bun.sleep(150);
    expect(overlay.tracker.active).toBe(true);
    // a later check: Ctrl is still seen as held
    overlay.tracker.stop();
    track(overlay, { x: 2000, y: 0, width: 400, height: 1390 });
    await Bun.sleep(150);
    expect(overlay.tracker.active).toBe(true);
    expect(hides()).toBe(0);
  });
});
