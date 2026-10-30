// Port of EE2 main/src/shortcuts/HostClipboard.ts on wl-clipboard, plus the
// passive clipboard watch from the user's `omarchy_new` branch
// (Shortcuts.startWaylandSelectionWatch).
import type { Logger } from "./logger";

const POLL_DELAY = 48;
const POLL_LIMIT = 500;

// EE2 restores after 120 ms; XWayland needs longer before the game has
// read the clipboard (DESIGN.md "Hotkeys").
const RESTORE_AFTER = 300;
// EE2's throttle: a chat / stash action within this window of the previous
// one is dropped ("Too many actions" disconnects).
const THROTTLE = 120;
// wl-paste blocks while the selection owner (Wine's X11 bridge) does not
// finish the transfer; never let one read hold up the poll or a macro.
const READ_TIMEOUT = 1000;

export interface ClipboardIO {
  read(): Promise<string>;
  write(text: string): Promise<void>;
}

// Runs `argv` and resolves with its stdout, or "" on failure or after
// `timeoutMs` (the process is killed; a child it left holding the pipe no
// longer matters).
export async function readCommand(argv: string[], timeoutMs = READ_TIMEOUT): Promise<string> {
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  const result = Promise.all([new Response(proc.stdout).text(), proc.exited]).catch(() => null);
  try {
    const res = await Promise.race([result, deadline]);
    if (!res) {
      proc.kill();
      return "";
    }
    const [text, code] = res;
    return code === 0 ? text : "";
  } finally {
    clearTimeout(timer);
  }
}

export const wlClipboard: ClipboardIO = {
  read() {
    return readCommand(["wl-paste", "--no-newline", "--type", "text"]);
  },
  async write(text: string) {
    // wl-copy forks a child that serves the selection; don't keep its pipes.
    const args = text === "" ? ["wl-copy", "--clear"] : ["wl-copy"];
    const proc = Bun.spawn(args, {
      stdin: text === "" ? "ignore" : new TextEncoder().encode(text),
      stdout: "ignore",
      stderr: "ignore",
    });
    await proc.exited;
  },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class HostClipboard {
  private pollPromise?: Promise<string>;
  private elapsed = 0;
  private shouldRestore = false;
  private initialDelay = POLL_DELAY;
  private busyUntil = 0;
  private busy = false;
  // A scheduled restore and the text it restores; a new action cancels it
  // and keeps the original text, so a late restore never lands between the
  // next action's clipboard write and its Ctrl+V.
  private pendingRestore?: { text: string; timer: ReturnType<typeof setTimeout> };
  // Our own clipboard writes must not look like game copies to the watch.
  private ownUntil = 0;

  constructor(
    private logger: Logger,
    private io: ClipboardIO = wlClipboard,
  ) {}

  get isPolling() {
    return this.pollPromise != null;
  }

  updateOptions(restoreClipboard: boolean) {
    this.shouldRestore = restoreClipboard;
  }

  updateDelay(delay: number) {
    this.initialDelay = delay;
  }

  get isOwnChange() {
    return this.isPolling || this.busy || Date.now() < this.ownUntil;
  }

  private async writeOwn(text: string) {
    this.ownUntil = Date.now() + 1000;
    await this.io.write(text);
  }

  private async takeSaved(): Promise<string> {
    if (this.pendingRestore) {
      clearTimeout(this.pendingRestore.timer);
      const { text } = this.pendingRestore;
      this.pendingRestore = undefined;
      return text;
    }
    return await this.io.read();
  }

  private scheduleRestore(text: string, delay: number) {
    if (!this.shouldRestore) return;
    const timer = setTimeout(() => {
      this.pendingRestore = undefined;
      this.writeOwn(text).catch(() => {});
    }, delay);
    this.pendingRestore = { text, timer };
  }

  // Resolves with the item text the game copied. `press` sends the copy
  // keys once the clipboard is armed (EE2 order: arm, press, poll). Like
  // EE2, a second call while polling presses again and shares the poll.
  async readItemText(press: () => Promise<void>): Promise<string> {
    this.elapsed = 0;
    if (this.pollPromise) {
      press().catch(() => {});
      return await this.pollPromise;
    }

    this.pollPromise = (async () => {
      let textBefore = await this.takeSaved();
      if (isPoeItem(textBefore)) {
        textBefore = "";
      }
      // EE2 on Linux always writes a sentinel: KDE's "Prevent empty
      // clipboard" (awakened-poe-trade#1790) and Proton 10+
      // (awakened-poe-trade#1846) need a visible change before the copy.
      await this.writeOwn(`__EE2_FORCE_EMPTY_${Date.now()}`);
      await press().catch((e) => {
        this.logger.write(`error [Shortcuts] ${(e as Error).message}`);
      });
      return textBefore;
    })().then(
      (textBefore) =>
        new Promise<string>((resolve, reject) => {
          const poll = async () => {
            // A failed read counts as "nothing yet": the poll must always
            // settle, or every later price check waits on it.
            let textAfter = "";
            try {
              textAfter = await this.io.read();
            } catch {}

            if (isPoeItem(textAfter)) {
              if (this.shouldRestore) {
                this.writeOwn(textBefore).catch(() => {});
              }
              this.pollPromise = undefined;
              resolve(textAfter);
            } else {
              this.elapsed += POLL_DELAY;
              if (this.elapsed < POLL_LIMIT) {
                setTimeout(poll, POLL_DELAY);
              } else {
                if (this.shouldRestore) {
                  this.writeOwn(textBefore).catch(() => {});
                }
                this.pollPromise = undefined;
                this.logger.write("warn [ClipboardPoller] No item text found.");
                reject(new Error("Reading clipboard timed out"));
              }
            }
          };
          setTimeout(poll, this.initialDelay);
        }),
    );
    const p = this.pollPromise;
    p.catch(() => {
      if (this.pollPromise === p) this.pollPromise = undefined;
    });

    return await p;
  }

  // Throttle + restore around chat and stash-search macros. Returns false
  // when the call was dropped by the throttle.
  async restoreShortly(cb: (write: (text: string) => Promise<void>) => Promise<void>): Promise<boolean> {
    // Not only do we not overwrite the clipboard, but we don't exec callback.
    // This throttling helps against disconnects from "Too many actions".
    if (this.busy || Date.now() < this.busyUntil) {
      return false;
    }

    let saved: string | undefined;
    this.busy = true;
    try {
      saved = await this.takeSaved();
      await cb((text) => this.writeOwn(text));
    } finally {
      // also when sending the keys failed: the macro text must not replace
      // the user's clipboard for good
      if (saved !== undefined) this.scheduleRestore(saved, RESTORE_AFTER);
      this.busy = false;
      this.busyUntil = Date.now() + THROTTLE;
      this.ownUntil = Math.max(this.ownUntil, Date.now() + RESTORE_AFTER + 200);
    }
    return true;
  }

  // Passive trigger mode: wait for the game's own copy (the key already
  // went to the game). No sentinel: it could overwrite the copy. Accepts the
  // first item text that differs from what was there when the key was
  // pressed, or, for a re-copy of the same item, the item still there at
  // the end of the poll window.
  async waitForGameCopy(): Promise<string> {
    const before = await this.io.read();
    await sleep(this.initialDelay);
    for (let elapsed = 0; ; elapsed += POLL_DELAY) {
      const text = await this.io.read();
      if (isPoeItem(text) && (text !== before || elapsed + POLL_DELAY >= POLL_LIMIT)) {
        return text;
      }
      if (elapsed + POLL_DELAY >= POLL_LIMIT) break;
      await sleep(POLL_DELAY);
    }
    this.logger.write("warn [ClipboardPoller] No item text found.");
    throw new Error("Reading clipboard timed out");
  }
}

// `wl-paste --watch` runs the command once per selection change with the
// content on stdin; the trailing NUL makes the output self-delimiting.
// Wine re-takes the X11 CLIPBOARD on every in-game copy, so copying the same
// item twice still produces two events.
export class ClipboardWatch {
  private proc?: Bun.Subprocess<"ignore", "pipe", "ignore">;
  private wanted = false;
  private retryDelay = 1000;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private lastConsumed = "";
  private lastConsumedAt = 0;

  constructor(
    private logger: Logger,
    private onItem: (text: string) => void,
    private ignore: () => boolean = () => false,
  ) {}

  get running() {
    return this.proc != null;
  }

  setActive(active: boolean) {
    if (active === this.wanted) return;
    this.wanted = active;
    if (active) {
      this.retryDelay = 1000;
      this.start();
    } else {
      clearTimeout(this.retryTimer);
      const proc = this.proc;
      this.proc = undefined;
      proc?.kill();
    }
  }

  private consume(text: string) {
    if (!isPoeItem(text) || this.ignore()) return;
    const now = Date.now();
    // One copy can surface twice through the XWayland bridge.
    if (text === this.lastConsumed && now - this.lastConsumedAt < 250) return;
    this.lastConsumed = text;
    this.lastConsumedAt = now;
    this.logger.write("info [ClipboardWatch] item copied (wayland) -> price-check");
    this.onItem(text);
  }

  private start() {
    const MAX_PAYLOAD = 512 * 1024;
    let proc: Bun.Subprocess<"ignore", "pipe", "ignore">;
    try {
      proc = Bun.spawn(["wl-paste", "--watch", "sh", "-c", 'cat; printf "\\000"'], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      });
    } catch (e) {
      this.logger.write(`error [ClipboardWatch] wl-paste unavailable: ${(e as Error).message}`);
      return;
    }
    this.proc = proc;
    (async () => {
      let buffer = Buffer.alloc(0);
      let overflow = false;
      // The first payload is the clipboard as it was when the watch started.
      let seeded = false;
      for await (const chunk of proc.stdout) {
        buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
        let end: number;
        while ((end = buffer.indexOf(0)) !== -1) {
          const payload = buffer.subarray(0, end);
          buffer = buffer.subarray(end + 1);
          const dropped = overflow;
          overflow = false;
          if (dropped) continue;
          if (!seeded) {
            seeded = true;
            continue;
          }
          this.consume(payload.toString("utf8"));
        }
        // A copied image streams through here too; drop it.
        if (buffer.length > MAX_PAYLOAD) {
          buffer = Buffer.alloc(0);
          overflow = true;
        }
      }
    })().catch(() => {});
    proc.exited.then(() => {
      if (this.proc !== proc) return; // stopped on purpose
      this.proc = undefined;
      if (!this.wanted) return;
      this.logger.write(
        `warn [ClipboardWatch] wl-paste watch exited, restarting in ${this.retryDelay}ms`,
      );
      this.retryTimer = setTimeout(() => this.wanted && this.start(), this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, 30_000);
    });
  }
}

export function isPoeItem(text: string) {
  return LANGUAGE_DETECTOR.find(
    ({ firstLine, uncutSkillGemLine }) =>
      text.startsWith(firstLine) || text.startsWith(uncutSkillGemLine),
  );
}

export const LANGUAGE_DETECTOR = [
  {
    lang: "en",
    firstLine: "Item Class: ",
    uncutSkillGemLine: "Rarity: ",
  },
  {
    lang: "ru",
    firstLine: "Класс предмета: ",
    uncutSkillGemLine: "Редкость: ",
  },
  {
    lang: "fr",
    firstLine: "Classe d'objet: ",
    uncutSkillGemLine: "Rareté: ",
  },
  {
    lang: "de",
    firstLine: "Gegenstandsklasse: ",
    uncutSkillGemLine: "Seltenheit: ",
  },
  {
    lang: "pt",
    firstLine: "Classe do Item: ",
    uncutSkillGemLine: "Raridade: ",
  },
  {
    lang: "es",
    firstLine: "Clase de objeto: ",
    uncutSkillGemLine: "Rareza: ",
  },
  {
    lang: "th",
    firstLine: "ชนิดไอเทม: ",
    uncutSkillGemLine: "Rarity: ",
  },
  {
    lang: "ko",
    firstLine: "아이템 종류: ",
    uncutSkillGemLine: "아이템 희귀도: ",
  },
  {
    lang: "cmn-Hant",
    firstLine: "物品種類: ",
    uncutSkillGemLine: "稀有度: ",
  },
  {
    lang: "cmn-Hans",
    firstLine: "物品类别: ",
    uncutSkillGemLine: "Rarity: ",
  },
  {
    lang: "ja",
    firstLine: "アイテムクラス: ",
    uncutSkillGemLine: "レアリティ: ",
  },
];
