// Port of EE2 main/src/host-files/GameConfig.ts: reads PoE2's ini for the
// "show advanced item descriptions" key, which EE2 merges into the copy
// chord (Ctrl + C + Alt by default).
//
// Changes from EE2: the section follows `[GENERAL] user_input_mode` (WASD
// players have their keys in `[WASD_ACTION_KEYS]`, falling back to
// `[ACTION_KEYS]`), and the file is re-read when its mtime changes, not
// only when the configured path changes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodeToKey, hotkeyToString } from "../../ipc/KeyToCode";
import type { Logger } from "./logger";

export function possiblePaths(home = os.homedir()) {
  const documents = process.env.XDG_DOCUMENTS_DIR || path.join(home, "Documents");
  return [
    path.join(documents, "My Games/Path of Exile 2/poe2_production_Config.ini"),
    path.join(
      home,
      ".local/share/Steam/steamapps/compatdata/2694490/pfx/drive_c/users/steamuser/Documents/My Games/Path of Exile 2/poe2_production_Config.ini",
    ),
  ];
}

// EE2 host-files/utils.ts: the single readable candidate; null if more than
// one is readable ("don't allow multiple matches"), undefined if none.
export function guessFileLocation(entries: Iterable<string>): string | null | undefined {
  let found: string | null | undefined;
  for (const p of entries) {
    try {
      fs.accessSync(p, fs.constants.R_OK);
      if (found != null) return null;
      found = p;
    } catch {}
  }
  return found;
}

// Minimal `ini.parse` for PoE's flat `[SECTION]` / `key=value` files.
export function parseIni(contents: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  let section: Record<string, string> = {};
  out[""] = section;
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const m = /^\[(.*)\]$/.exec(line);
    if (m) {
      section = out[m[1]] ??= {};
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    section[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

export class GameConfig {
  private _wantedPath: string | null = null;
  private _actualPath: string | null = null;
  private _mtime = 0;
  private _showModsKey: string | null = null;

  constructor(
    private logger: Logger,
    private candidates: string[] = possiblePaths(),
  ) {}

  get actualPath() {
    return this._actualPath;
  }

  get showModsKey() {
    return this._showModsKey ?? "Alt";
  }

  // Returns true when showModsKey changed.
  readConfig(filePath: string): boolean {
    const before = this.showModsKey;
    if (this._wantedPath !== filePath) {
      this._wantedPath = filePath;
      this._actualPath = null;
      this._mtime = 0;
      this._showModsKey = null;
    } else if (this._actualPath) {
      // same path: only re-read when the file changed
      let mtime = 0;
      try {
        mtime = fs.statSync(this._actualPath).mtimeMs;
      } catch {}
      if (mtime === this._mtime) return false;
    } else {
      return false;
    }

    if (!filePath.length) {
      const guessedPath = guessFileLocation(this.candidates);
      if (guessedPath != null) {
        filePath = guessedPath;
      } else {
        this.logger.write(
          "error [GameConfig] Failed to find game configuration file in the default location.",
        );
        return before !== this.showModsKey;
      }
    }

    try {
      this._mtime = fs.statSync(filePath).mtimeMs;
      let contents = fs.readFileSync(filePath, "utf8");
      contents = contents.replace(/^﻿/, "").trimStart(); // remove BOM
      const parsed = parseIni(contents);

      const wasd = parsed.GENERAL?.user_input_mode === "wasd";
      const value =
        (wasd ? parsed.WASD_ACTION_KEYS?.show_advanced_item_descriptions : undefined) ??
        parsed.ACTION_KEYS?.show_advanced_item_descriptions;
      this._showModsKey = this.parseConfigHotkey(value);
      this._actualPath = filePath;
    } catch {
      this.logger.write("error [GameConfig] Failed to read game configuration file.");
    }
    return before !== this.showModsKey;
  }

  private parseConfigHotkey(cfgKey?: string): string | null {
    if (!cfgKey) return null;

    const [keyMain, keyMod] = cfgKey.split(" ");

    let key1: string;
    if (CodeToKey[keyMain]) {
      key1 = CodeToKey[keyMain];
    } else {
      this.logger.write(`error [GameConfig] Failed to read key: ${cfgKey}.`);
      return null;
    }

    let key2: string | undefined;
    if (keyMod) {
      if (keyMod === "1") {
        key2 = "Shift";
      } else if (keyMod === "2") {
        key2 = "Ctrl";
      } else if (keyMod === "3") {
        key2 = "Alt";
      } else {
        this.logger.write(`error [GameConfig] Failed to read modifier key: ${cfgKey}.`);
        return null;
      }
    }

    return hotkeyToString([key1], key2 === "Ctrl", key2 === "Shift", key2 === "Alt");
  }
}
