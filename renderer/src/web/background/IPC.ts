import type {
  IpcEvent,
  IpcEventPayload,
  UpdateInfo,
  HostState,
} from "@ipc/types";
import { shallowRef } from "vue";
import Sockette from "sockette";

// OmaExiled: what this page is, from its `?mode=` parameter.
// - "overlay": the layer surface over the game window (EE2's Electron overlay)
// - "settings": the standalone settings window
// - "browser": no parameter, EE2's browser mode
export type HostMode = "overlay" | "settings" | "browser";

function pageMode(): HostMode {
  const mode = new URLSearchParams(window.location.search).get("mode");
  return mode === "overlay" || mode === "settings" ? mode : "browser";
}

class HostTransport {
  private evBus = new EventTarget();
  private socket!: Sockette;
  private reconnectCbs = new Set<() => void>();
  readonly mode: HostMode = pageMode();
  logs = shallowRef("");
  version = shallowRef("0.0.00000");
  updateInfo = shallowRef<UpdateInfo>({ state: "initial" });

  async init() {
    this.onEvent("MAIN->CLIENT::log-entry", (entry) => {
      this.logs.value += entry.message;
    });
    this.onEvent("MAIN->CLIENT::updater-state", (info) => {
      this.updateInfo.value = info;
    });
    await new Promise((resolve) => {
      let opened = false;
      this.socket = new Sockette(
        `ws://${window.location.host}/events?role=${this.mode}`,
        {
          onmessage: (e) => {
            this.selfDispatch(JSON.parse(e.data));
          },
          onopen: (e) => {
            if (!opened) {
              opened = true;
              resolve(e);
            } else {
              this.reconnectCbs.forEach((cb) => cb());
            }
          },
        },
      );
    });
  }

  selfDispatch(event: IpcEvent) {
    this.evBus.dispatchEvent(
      new CustomEvent(event.name, {
        detail: event.payload,
      }),
    );
  }

  sendEvent(event: IpcEvent) {
    this.socket.send(JSON.stringify(event));
  }

  onEvent<Name extends IpcEvent["name"]>(
    name: Name,
    cb: (payload: IpcEventPayload<Name>) => void,
  ): AbortController {
    const controller = new AbortController();
    if (!this.isOverlay && name.startsWith("MAIN->OVERLAY")) {
      return controller;
    }

    this.evBus.addEventListener(
      name,
      (e) => {
        cb((e as CustomEvent<IpcEventPayload<Name>>).detail);
      },
      { signal: controller.signal },
    );
    return controller;
  }

  // OmaExiled: called after the WebSocket reconnects (e.g. a backend
  // restart), which forgets state that was only sent on change.
  onReconnect(cb: () => void): () => void {
    this.reconnectCbs.add(cb);
    return () => this.reconnectCbs.delete(cb);
  }

  async getConfig(): Promise<string | null> {
    const response = await fetch("/config");
    const config = (await response.json()) as HostState;
    // TODO: refactor this
    this.version.value = config.version;
    this.updateInfo.value = config.updater;
    return config.contents;
  }

  proxy: (typeof window)["fetch"] = async (url, init) => {
    return await window.fetch(`/proxy/${url as string}`, init);
  };

  // OmaExiled: replaces EE2's `isElectron` UA sniff. The overlay page has
  // EE2's Electron overlay semantics.
  get isOverlay() {
    return this.mode === "overlay";
  }

  // OmaExiled: use instead of window.screenX/Y in position math. In overlay
  // mode item-text positions are relative to the overlay surface, which
  // covers exactly the game window, whatever position Qt reports for it.
  get screenX() {
    return this.isOverlay ? 0 : window.screenX;
  }

  get screenY() {
    return this.isOverlay ? 0 : window.screenY;
  }
}

export const MainProcess = new HostTransport();
export const Host = MainProcess;
