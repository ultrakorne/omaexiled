// Port of EE2's overlay focus model (main/src/windowing/OverlayWindow.ts,
// GameWindow.ts, WidgetAreaTracker.ts) onto Hyprland + the Qt host.
//
// EE2 moved keyboard focus between the game and its overlay window. Here
// the game keeps the Hyprland focus; `overlayActive` (EE2 isInteractable)
// is a mode the renderer is told about through `focus-change`, and the host
// maps the layer surface over the game window while the page has something
// to show. See DESIGN.md "Overlay model".
import type { IpcEvent, IpcEventPayload, InputRect } from "../../ipc/types";
import { GAME_CLASS } from "./binds";
import { monitorLogicalRect, type HyprClient, type HyprMonitor, type Hyprland, type Rect } from "./hyprland";
import type { Logger } from "./logger";

type ItemText = IpcEventPayload<"MAIN->CLIENT::item-text">;
type TrackArea = IpcEventPayload<"OVERLAY->MAIN::track-area">;

// How often the cursor is checked against the panel while one is shown.
const POINTER_POLL = 50;

export interface OverlayDeps {
  hypr: Hyprland;
  logger: Logger;
  broadcast(event: IpcEvent): void;
  sendItemText(payload: ItemText): void;
  host: {
    readonly connected: boolean;
    send(msg: object): boolean;
  };
  setPanel(visible: boolean): void;
  onChange(): void; // shell state
  onGamePresence(present: boolean): void;
}

export interface SurfaceGeometry {
  output: string;
  rect: Rect; // monitor-local logical px (host overlay.show)
  origin: { x: number; y: number }; // global logical position of the surface
}

// Hyprland emits `activewindow>>,` when our layer surface takes the
// keyboard, often right before re-announcing the game. Wait this long and
// ask again before treating the game as unfocused.
const BLUR_DEBOUNCE = 120;
const TRACK_INTERVAL = 50;
// Unusable key-state replies in a row before a tracking session falls back
// to "key released" (a Hyprland without hl.is_key_down).
const KEY_QUERY_ATTEMPTS = 3;

export class OverlayState {
  gameFocused = false;
  overlayActive = false; // EE2 isInteractable
  wasUsedRecently = true;
  private isOverlayKeyUsed = false;
  shouldShow = false;
  windowTitle = "Path of Exile 2";

  game: HyprClient | null = null;
  private monitors: HyprMonitor[] = [];
  private activeAddress = "";
  shown: SurfaceGeometry | null = null;
  // Geometry the host last got (overlay.show / overlay.prepare): the hidden
  // overlay page keeps the game window's viewport.
  private hostGeometry: { output: string; rect: Rect } | null = null;
  // PoE2 closed or crashed: the surface stays unmapped until something asks
  // for it again (a price check, the overlay key), even if the page still
  // reports shouldShow.
  private gameGone = false;
  // Last value sent to the binds (`_G.omaexiled.panel`).
  private panelSent = false;
  hostMapped = false;
  hostKeyboardFocus = false;
  private inputRegion: { rects: InputRect[]; full: boolean } = { rects: [], full: false };
  private blurTimer?: ReturnType<typeof setTimeout>;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private warnedFullscreen = false;
  private lastFocusSent = "";
  readonly tracker: AreaTracker;

  constructor(private deps: OverlayDeps) {
    this.tracker = new AreaTracker(deps.hypr, this);
  }

  isGame(w: { class: string; title: string } | null | undefined) {
    return !!w && (w.class === GAME_CLASS || w.title === this.windowTitle);
  }

  setWindowTitle(title: string) {
    if (title && title !== this.windowTitle) {
      this.windowTitle = title;
      this.scheduleRefresh();
    }
  }

  // --- Hyprland state ----------------------------------------------------

  async refresh() {
    if (!this.deps.hypr.available) return;
    let clients: HyprClient[];
    let active: HyprClient | null;
    try {
      [clients, this.monitors, active] = await Promise.all([
        this.deps.hypr.clients(),
        this.deps.hypr.monitors(),
        this.deps.hypr.activeWindow(),
      ]);
    } catch (e) {
      this.deps.logger.write(`error [Hyprland] ${(e as Error).message}`);
      return;
    }
    const games = clients.filter((c) => this.isGame(c) && c.mapped);
    const game =
      games.find((c) => c.address === active?.address) ??
      games.find((c) => c.address === this.game?.address) ??
      games.find((c) => !c.hidden) ??
      games[0] ??
      null;
    const hadGame = this.game != null;
    this.game = game;
    if (game && game.fullscreen === 2 && !this.warnedFullscreen) {
      this.warnedFullscreen = true;
      this.deps.logger.write(
        "warn [Overlay] Path of Exile 2 runs in Windowed Fullscreen/Fullscreen; if copying items or overlay clicks fail, use the in-game Windowed mode",
      );
    }
    if (hadGame !== (game != null)) {
      this.deps.logger.write(game ? `info [Overlay] Path of Exile 2 detected (${game.address})` : "info [Overlay] Path of Exile 2 closed");
      this.gameGone = !game;
      if (!game) {
        // EE2 hid the overlay window when the game window went away. The
        // renderer drops the panel (it must not come back over the next
        // game) and the surface is unmapped now, whatever the page reports.
        this.tracker.stop();
        this.deps.broadcast({ name: "MAIN->OVERLAY::hide-exclusive-widget", payload: undefined });
        if (this.overlayActive) this.assertGameActive();
        else this.sync();
      }
      this.deps.onGamePresence(game != null);
    }
    this.activeAddress = active?.address ?? "";
    this.applyFocus(this.computeFocused(active));
    // geometry may have changed under a visible overlay; a hidden one keeps
    // the host's page sized like the game window
    if (this.shown) this.sync();
    else this.prepare();
    this.deps.onChange();
  }

  private scheduleRefresh(delay = 30) {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refresh(), delay);
  }

  private gameWorkspaceVisible() {
    const g = this.game;
    if (!g) return false;
    const m = this.monitors.find((m) => m.id === g.monitor);
    if (!m) return false;
    if (m.specialWorkspace?.id && m.specialWorkspace.id !== g.workspace.id) return false;
    return m.activeWorkspace.id === g.workspace.id || m.specialWorkspace?.id === g.workspace.id;
  }

  private computeFocused(active: HyprClient | null) {
    if (active) return this.isGame(active);
    // Nothing focused while our panel is mapped over the game: the layer
    // surface holds the keyboard, the game is still the window in front.
    return this.game != null && (this.shown != null || this.hostKeyboardFocus) && this.gameWorkspaceVisible();
  }

  handleEvent(event: string, data: string) {
    switch (event) {
      case "activewindow": {
        const comma = data.indexOf(",");
        const cls = comma < 0 ? data : data.slice(0, comma);
        const title = comma < 0 ? "" : data.slice(comma + 1);
        clearTimeout(this.blurTimer);
        if (!cls && !title) {
          this.blurTimer = setTimeout(() => this.refresh(), BLUR_DEBOUNCE);
        } else if (this.isGame({ class: cls, title })) {
          if (!this.game) this.scheduleRefresh(0);
          this.applyFocus(true);
        } else {
          this.applyFocus(false);
        }
        break;
      }
      case "activewindowv2":
        this.activeAddress = data ? `0x${data}` : "";
        // another PoE2 window took focus (follows `activewindow>>`)
        if (this.gameFocused && this.activeAddress && this.activeAddress !== this.game?.address) {
          this.scheduleRefresh(0);
        }
        break;
      case "openwindow":
      case "closewindow":
      case "windowtitlev2":
      case "movewindowv2":
      case "fullscreen":
      case "changefloatingmode":
      case "monitoraddedv2":
      case "monitorremovedv2":
      case "workspacev2":
      case "activespecialv2":
      case "focusedmonv2":
        this.scheduleRefresh();
        break;
    }
  }

  private applyFocus(focused: boolean) {
    if (focused === this.gameFocused) return;
    this.gameFocused = focused;
    // EE2 handlePoeWindowActiveChange: the game taking focus ends the
    // active mode. The port also ends it when the game loses focus: the
    // overlay is hidden then, it must not come back active.
    if (this.overlayActive) this.overlayActive = false;
    if (!focused) {
      this.tracker.stop();
      // EE2 hid hide-on-blur widgets on every blur; the renderer's wasActive
      // guard keeps a quick (inactive) panel, so close it here. Otherwise it
      // would come back over the game on return, without hold-mode tracking.
      if (this.shouldShow) {
        this.deps.broadcast({ name: "MAIN->OVERLAY::hide-exclusive-widget", payload: undefined });
      }
    }
    this.emitFocusChange();
    this.sync();
    this.deps.onChange();
  }

  private emitFocusChange(force = false) {
    const payload = {
      game: this.gameFocused && !this.overlayActive,
      overlay: this.overlayActive,
      usingHotkey: this.isOverlayKeyUsed,
    };
    this.isOverlayKeyUsed = false;
    const key = `${payload.game},${payload.overlay}`;
    if (!force && key === this.lastFocusSent) return;
    this.lastFocusSent = key;
    this.deps.broadcast({ name: "MAIN->OVERLAY::focus-change", payload });
    void this.pollPointer();
  }

  // The current focus state for a page that just connected.
  focusChangeEvent(): IpcEvent {
    return {
      name: "MAIN->OVERLAY::focus-change",
      payload: { game: this.gameFocused && !this.overlayActive, overlay: this.overlayActive, usingHotkey: false },
    };
  }

  // --- EE2 OverlayWindow -------------------------------------------------

  assertOverlayActive = () => {
    this.gameGone = false;
    if (!this.overlayActive) {
      this.overlayActive = true;
      this.emitFocusChange(true);
      this.sync();
    }
  };

  assertGameActive = () => {
    if (this.overlayActive) {
      this.overlayActive = false;
      this.emitFocusChange(true);
      this.sync();
    }
  };

  toggleActiveState = () => {
    this.isOverlayKeyUsed = true;
    if (this.overlayActive) {
      this.assertGameActive();
    } else {
      this.assertOverlayActive();
    }
  };

  // Overlay key (Shift + Space), as in EE2: toggles the active overlay
  // (menu plus whatever widgets are open).
  toggleOverlay() {
    this.tracker.stop();
    this.toggleActiveState();
  }

  // Escape while a panel is visible, `ctl hide`.
  closePanel() {
    this.tracker.stop();
    this.deps.broadcast({ name: "MAIN->OVERLAY::hide-exclusive-widget", payload: undefined });
    this.assertGameActive();
  }

  closePanelFromTracker() {
    this.deps.broadcast({ name: "MAIN->OVERLAY::hide-exclusive-widget", payload: undefined });
  }

  sendItemText(payload: ItemText) {
    this.gameGone = false;
    this.deps.sendItemText(payload);
  }

  // --- renderer events ---------------------------------------------------

  onRenderState(shouldShow: boolean) {
    this.shouldShow = shouldShow;
    if (!shouldShow) this.tracker.stop();
    this.sync();
  }

  onInputRegion(region: { rects: InputRect[]; full: boolean }) {
    this.inputRegion = { rects: region.rects ?? [], full: Boolean(region.full) };
    if (this.shown) this.deps.host.send({ type: "overlay.input", ...this.inputRegion });
    this.updatePanel();
    void this.pollPointer();
  }

  // --- keyboard grab -------------------------------------------------------
  // PoE2 confines the pointer to its window. Hyprland honours that while
  // the game has keyboard focus and then never hands the pointer to the
  // panel, so hovering alone can't focus it. While a panel is shown the
  // backend watches the cursor; over the panel (or in the active mode) the
  // overlay takes the keyboard (exclusive), which releases the game's
  // constraint. Off the panel the game gets the keyboard back.

  private grab = false;
  private pointerTimer?: ReturnType<typeof setInterval>;
  private pointerPolling = false;

  private updatePointerWatch() {
    if (this.shown && !this.pointerTimer) {
      this.pointerTimer = setInterval(() => void this.pollPointer(), POINTER_POLL);
    } else if (!this.shown && this.pointerTimer) {
      clearInterval(this.pointerTimer);
      this.pointerTimer = undefined;
      this.grab = false;
    }
  }

  async pollPointer() {
    if (!this.shown || this.pointerPolling || !this.deps.hypr.available) return;
    this.pointerPolling = true;
    try {
      let grab = this.overlayActive || this.inputRegion.full;
      if (!grab && this.inputRegion.rects.length) {
        const pos = await this.deps.hypr.cursorPos();
        const shown = this.shown;
        if (!shown) return;
        const x = pos.x - shown.origin.x;
        const y = pos.y - shown.origin.y;
        grab = this.inputRegion.rects.some(
          (r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height,
        );
      }
      if (grab !== this.grab && this.shown) {
        this.grab = grab;
        this.deps.host.send({ type: "overlay.keyboard", grab });
      }
    } catch {
      // cursor query failed: keep the current grab until the next poll
    } finally {
      this.pointerPolling = false;
    }
  }

  onTrackArea(opts: TrackArea) {
    this.tracker.start(opts);
  }

  onHostState(mapped: boolean, keyboardFocus: boolean) {
    this.hostMapped = mapped;
    this.hostKeyboardFocus = keyboardFocus;
  }

  // Host (re)connected or gone: it has no surface and no geometry yet.
  onHostConnected() {
    this.shown = null;
    this.updatePointerWatch();
    this.hostGeometry = null;
    this.updatePanel();
    this.sync();
  }

  // --- geometry ----------------------------------------------------------

  // The surface covers the game window (clamped to its monitor), or the
  // monitor under the cursor when there is no game (tests, browser use).
  async geometry(fresh = false): Promise<SurfaceGeometry | null> {
    if (fresh && this.deps.hypr.available) {
      try {
        const [clients, monitors] = await Promise.all([this.deps.hypr.clients(), this.deps.hypr.monitors()]);
        this.monitors = monitors;
        const games = clients.filter((c) => this.isGame(c) && c.mapped);
        this.game =
          games.find((c) => c.address === this.game?.address) ?? games.find((c) => !c.hidden) ?? games[0] ?? this.game;
      } catch {}
    }
    return this.computeGeometry();
  }

  private cursorMonitor: HyprMonitor | undefined;

  computeGeometry(): SurfaceGeometry | null {
    const g = this.game;
    if (g) {
      const m = this.monitors.find((m) => m.id === g.monitor);
      if (!m) return null;
      const mr = monitorLogicalRect(m);
      const x0 = Math.max(g.at[0], mr.x);
      const y0 = Math.max(g.at[1], mr.y);
      const x1 = Math.min(g.at[0] + g.size[0], mr.x + mr.width);
      const y1 = Math.min(g.at[1] + g.size[1], mr.y + mr.height);
      if (x1 <= x0 || y1 <= y0) return null;
      return {
        output: m.name,
        rect: { x: x0 - mr.x, y: y0 - mr.y, width: x1 - x0, height: y1 - y0 },
        origin: { x: x0, y: y0 },
      };
    }
    const m = this.cursorMonitor ?? this.monitors.find((m) => m.focused) ?? this.monitors[0];
    if (!m) return null;
    const mr = monitorLogicalRect(m);
    return { output: m.name, rect: { x: 0, y: 0, width: mr.width, height: mr.height }, origin: { x: mr.x, y: mr.y } };
  }

  // Cursor in overlay-surface coordinates (DESIGN.md `item-text.position`).
  async cursorInSurface(): Promise<{ x: number; y: number }> {
    if (!this.deps.hypr.available) return { x: 0, y: 0 };
    const [pos, geo] = await Promise.all([
      this.deps.hypr.cursorPos().catch(() => ({ x: 0, y: 0 })),
      this.geometry(true),
    ]);
    if (!this.game) {
      const m = this.monitors.find((m) => {
        const r = monitorLogicalRect(m);
        return pos.x >= r.x && pos.x < r.x + r.width && pos.y >= r.y && pos.y < r.y + r.height;
      });
      if (m) this.cursorMonitor = m;
      const g2 = this.computeGeometry();
      return g2 ? { x: pos.x - g2.origin.x, y: pos.y - g2.origin.y } : pos;
    }
    return geo ? { x: pos.x - geo.origin.x, y: pos.y - geo.origin.y } : pos;
  }

  // --- host surface ------------------------------------------------------

  private syncing = false;
  private resyncWanted = false;

  sync() {
    if (this.syncing) {
      this.resyncWanted = true;
      return;
    }
    this.syncing = true;
    this.doSync()
      .catch((e) => this.deps.logger.write(`error [Overlay] ${(e as Error).message}`))
      .finally(() => {
        this.syncing = false;
        if (this.resyncWanted) {
          this.resyncWanted = false;
          this.sync();
        }
      });
  }

  private async doSync() {
    // Without a game (ctl, browser use) the surface covers a monitor, but
    // not after PoE2 closed under a visible panel.
    const want =
      this.deps.host.connected &&
      (this.shouldShow || this.overlayActive) &&
      (this.game ? this.gameFocused : !this.gameGone);
    const wasShown = this.shown != null;
    if (want) {
      const geo = await this.geometry(!this.shown);
      if (geo) {
        if (!this.shown || geo.output !== this.shown.output || !sameRect(geo.rect, this.shown.rect)) {
          this.deps.host.send({ type: "overlay.show", output: geo.output, rect: geo.rect });
          this.deps.host.send({ type: "overlay.input", ...this.inputRegion });
          this.hostGeometry = { output: geo.output, rect: geo.rect };
        }
        this.shown = geo;
      }
    } else if (this.shown) {
      this.deps.host.send({ type: "overlay.hide" });
      this.shown = null;
    }
    if (!this.shown) this.prepare();
    this.updatePanel();
    this.updatePointerWatch();
    if (this.shown && !wasShown) {
      this.grab = false;
      void this.pollPointer();
    }
    if (wasShown !== (this.shown != null)) {
      this.deps.onChange();
    }
  }

  // overlay.prepare: while hidden, the host warm-up maps the page on the
  // game's output with the game window's size, so the next show renders
  // with the right viewport. Sent on host connect and when the game window
  // moves (without a game only on connect: the monitor is a fallback).
  private prepare() {
    if (this.shown || !this.deps.host.connected) return;
    const last = this.hostGeometry;
    if (!this.game && last) return;
    const geo = this.computeGeometry();
    if (!geo) return;
    if (last && last.output === geo.output && sameRect(last.rect, geo.rect)) return;
    this.hostGeometry = { output: geo.output, rect: geo.rect };
    this.deps.host.send({ type: "overlay.prepare", output: geo.output, rect: geo.rect });
  }

  // Escape closes a panel only while one is visible: an exclusive widget
  // (the page's input region is not empty) or the active mode. A surface
  // mapped for the debug key log or the editing banner is not a panel.
  get panelVisible() {
    return this.shown != null && (this.overlayActive || this.inputRegion.full || this.inputRegion.rects.length > 0);
  }

  private updatePanel() {
    const visible = this.panelVisible;
    if (visible === this.panelSent) return;
    this.panelSent = visible;
    this.deps.setPanel(visible);
  }

  status() {
    return {
      gameDetected: this.game != null,
      gameFocused: this.gameFocused,
      game: this.game
        ? {
            address: this.game.address,
            class: this.game.class,
            title: this.game.title,
            at: this.game.at,
            size: this.game.size,
            fullscreen: this.game.fullscreen,
            workspace: this.game.workspace.id,
          }
        : null,
      activeAddress: this.activeAddress,
      overlayActive: this.overlayActive,
      shouldShow: this.shouldShow,
      shown: this.shown,
      hostMapped: this.hostMapped,
      hostKeyboardFocus: this.hostKeyboardFocus,
      inputRegion: this.inputRegion,
      tracking: this.tracker.active,
    };
  }
}

function sameRect(a: Rect, b: Rect) {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

// EE2 WidgetAreaTracker for hold-mode price checks (`focusOverlay: false`):
// the panel closes when the hold key is released and the cursor moves more
// than `closeThreshold` from where the hotkey was pressed, unless the
// cursor entered the panel first (that stops tracking). Polls Hyprland,
// since there is no global pointer hook on Wayland.
export class AreaTracker {
  private timer?: ReturnType<typeof setInterval>;
  private opts?: TrackArea;
  private busy = false;
  private badKeyReplies = 0;

  constructor(
    private hypr: Hyprland,
    private overlay: OverlayState,
  ) {}

  get active() {
    return this.timer != null;
  }

  start(opts: TrackArea) {
    this.stop();
    if (!this.hypr.available) return;
    this.opts = opts;
    this.badKeyReplies = 0;
    this.timer = setInterval(() => this.poll(), TRACK_INTERVAL);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    this.opts = undefined;
  }

  // Cursor (global logical) and modifier state in one request. Hyprland
  // has no modifier query; hl.is_key_down takes keysym names. A failed
  // request (timeout while Hyprland stalls) throws: poll() skips the tick
  // instead of treating the hold key as released.
  private async sample(): Promise<{ x: number; y: number; ctrl: boolean; alt: boolean } | null> {
    if (this.badKeyReplies < KEY_QUERY_ATTEMPTS) {
      const out = await this.hypr.repl(
        'local p = hl.get_cursor_pos() return p.x, p.y, hl.is_key_down("Control_L") or hl.is_key_down("Control_R"), hl.is_key_down("Alt_L") or hl.is_key_down("Alt_R")',
      );
      const [x, y, ctrl, alt] = out.split("\t");
      if (x !== undefined && !Number.isNaN(Number(x)) && (ctrl === "true" || ctrl === "false")) {
        this.badKeyReplies = 0;
        return { x: Number(x), y: Number(y), ctrl: ctrl === "true", alt: alt === "true" };
      }
      // An error reply: the key-state API may be missing. After a few in a
      // row, fall back to "key released" (DESIGN.md) for this session.
      if (++this.badKeyReplies < KEY_QUERY_ATTEMPTS) return null;
    }
    const p = await this.hypr.cursorPos();
    return { x: p.x, y: p.y, ctrl: false, alt: false };
  }

  private async poll() {
    if (this.busy || !this.opts) return;
    this.busy = true;
    try {
      const opts = this.opts;
      const s = await this.sample();
      if (!s || this.opts !== opts) return;
      const origin = this.overlay.shown?.origin ?? this.overlay.computeGeometry()?.origin ?? { x: 0, y: 0 };
      const point = { x: s.x - origin.x, y: s.y - origin.y };
      const modifier = s.ctrl ? "Ctrl" : s.alt ? "Alt" : undefined;
      if (isPointInsideRect(point, opts.area)) {
        // entered the panel: it stays until closed explicitly
        this.stop();
      } else if (!this.overlay.overlayActive && modifier !== opts.holdKey) {
        // CSS px of the surface are logical px (the page zoom is 1)
        const distance = Math.hypot(point.x - opts.from.x, point.y - opts.from.y);
        if (distance > opts.closeThreshold) {
          this.stop();
          this.overlay.closePanelFromTracker();
        }
      } else if (this.overlay.overlayActive) {
        this.stop();
      }
    } catch {
      // Hyprland busy or gone: try again next tick
    } finally {
      this.busy = false;
    }
  }
}

function isPointInsideRect(point: { x: number; y: number }, rect: Rect) {
  return (
    point.x > rect.x &&
    point.x < rect.x + rect.width &&
    point.y > rect.y &&
    point.y < rect.y + rect.height
  );
}
