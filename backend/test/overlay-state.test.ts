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
  };
  world.active = world.clients[0];
  const hypr = {
    available: true,
    clients: async () => world.clients,
    monitors: async () => world.monitors,
    activeWindow: async () => world.active,
    cursorPos: async () => world.cursor,
    repl: async () => {
      throw new Error("no repl");
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
    host: { connected: true, send: (m) => (hostMsgs.push(m), true) },
    setPanel: (v) => panel.push(v),
    onChange: () => {},
    onGamePresence: (p) => presence.push(p),
  });
  const focusChanges = () =>
    events.filter((e) => e.name === "MAIN->OVERLAY::focus-change").map((e) => (e as any).payload);
  return { world, overlay, events, hostMsgs, panel, presence, focusChanges };
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
    const { overlay, hostMsgs, panel } = setup();
    await overlay.refresh();
    overlay.onRenderState(true);
    overlay.onInputRegion({ rects: [{ x: 1, y: 2, width: 3, height: 4 }], full: false });
    await settle();
    expect(hostMsgs).toEqual([
      { type: "overlay.show", output: "DP-1", rect: { x: 12, y: 38, width: 2536, height: 1390 } },
      { type: "overlay.input", rects: [{ x: 1, y: 2, width: 3, height: 4 }], full: false },
    ]);
    overlay.onInputRegion({ rects: [], full: true });
    overlay.onRenderState(false);
    await settle();
    expect(hostMsgs.slice(2)).toEqual([{ type: "overlay.input", rects: [], full: true }, { type: "overlay.hide" }]);
    expect(panel).toEqual([true, false]);
  });

  test("hidden on game blur, back on focus", async () => {
    const { overlay, hostMsgs } = setup();
    await overlay.refresh();
    overlay.onRenderState(true);
    await settle();
    overlay.handleEvent("activewindow", "firefox,x");
    await settle();
    expect(hostMsgs.at(-1)).toEqual({ type: "overlay.hide" });
    overlay.handleEvent("activewindow", "steam_app_2694490,Path of Exile 2");
    await settle();
    expect(hostMsgs.at(-2)!.type).toBe("overlay.show");
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

describe("hold-mode tracker (EE2 WidgetAreaTracker)", () => {
  test("released hold key + moved away closes; entering the panel stops", async () => {
    const { world, overlay, events } = setup();
    await overlay.refresh();
    const from = { x: 988, y: 462 };
    const track = (area: { x: number; y: number; width: number; height: number }) =>
      overlay.onTrackArea({ holdKey: "Ctrl", closeThreshold: 40, from, area, dpr: 1 });

    // no key-state query (repl fails): treated as released
    track({ x: 2000, y: 0, width: 400, height: 1390 });
    world.cursor = { x: 1010, y: 500 }; // 22 px: inside the threshold
    await Bun.sleep(120);
    expect(overlay.tracker.active).toBe(true);
    world.cursor = { x: 1100, y: 500 };
    await Bun.sleep(120);
    expect(overlay.tracker.active).toBe(false);
    expect(events.at(-1)!.name).toBe("MAIN->OVERLAY::hide-exclusive-widget");

    const before = events.length;
    track({ x: 1050, y: 0, width: 400, height: 1390 });
    world.cursor = { x: 1200, y: 500 }; // surface x 1188: inside the area
    await Bun.sleep(120);
    expect(overlay.tracker.active).toBe(false);
    expect(events.length).toBe(before);
  });
});
