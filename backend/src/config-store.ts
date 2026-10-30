// Port of EE2 main/src/host-files/ConfigStore.ts.
//
// config.json is the renderer's config, stored verbatim (the backend never
// parses it except to show the league in the bar). Changes from EE2:
// - atomic writes (`.writing` + rename) and no exit on a failed write;
// - invalid JSON on disk is moved aside to `config.json.bad-<ts>` and
//   served as `null`, so the renderer starts from defaults;
// - EE2's config is imported once into an empty config dir;
// - host-config.json caches the last HostConfig so binds exist before any
//   page connects.
import fs from "node:fs";
import path from "node:path";
import type { HostConfig } from "../../ipc/types";
import type { Logger } from "./logger";

export class ConfigStore {
  private isTmpFile = false;
  private cfgPath: string;
  private writeChain = Promise.resolve();

  constructor(
    private dir: string,
    private logger: Logger,
    private ee2Config?: string,
  ) {
    this.cfgPath = path.join(dir, "config.json");
  }

  get path() {
    return this.cfgPath;
  }

  // Copy EE2's config.json into an empty OmaExiled config dir, once.
  // The renderer runs its own migrations (`upgradeConfig`) on it.
  importEe2Once() {
    const marker = path.join(this.dir, ".ee2-imported");
    if (!this.ee2Config) return false;
    if (fs.existsSync(this.cfgPath) || fs.existsSync(marker)) return false;
    let contents: string;
    try {
      contents = fs.readFileSync(this.ee2Config, "utf8");
    } catch {
      return false;
    }
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      writeAtomic(this.cfgPath, contents);
      fs.writeFileSync(marker, `${this.ee2Config}\n`);
      this.logger.write(`info [ConfigStore] Imported Exiled Exchange 2 config from ${this.ee2Config}`);
      return true;
    } catch (e) {
      this.logger.write(`error [ConfigStore] Failed to import ${this.ee2Config}: ${(e as Error).message}`);
      return false;
    }
  }

  async load(): Promise<string | null> {
    await this.writeChain;
    let contents: string;
    try {
      contents = await Bun.file(this.cfgPath).text();
    } catch {
      return null;
    }
    try {
      JSON.parse(contents);
    } catch {
      const bad = `${this.cfgPath}.bad-${Date.now()}`;
      try {
        fs.renameSync(this.cfgPath, bad);
        this.logger.write(`error [ConfigStore] ${this.cfgPath} is not valid JSON, moved it to ${bad}`);
      } catch (e) {
        this.logger.write(`error [ConfigStore] ${this.cfgPath} is not valid JSON: ${(e as Error).message}`);
      }
      return null;
    }
    return contents;
  }

  // EE2: `isTemporary` (sent when config.json did not parse) switches every
  // later save and load to `config.json.tmp` for the rest of the process.
  save(contents: string, tmp: boolean) {
    if (tmp && !this.isTmpFile) {
      this.cfgPath += ".tmp";
      this.isTmpFile = true;
    }
    const target = this.cfgPath;
    this.writeChain = this.writeChain.then(() => {
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        writeAtomic(target, contents);
      } catch (e) {
        this.logger.write(`error [ConfigStore] Failed to save ${target}: ${(e as Error).message}`);
      }
    });
    return this.writeChain;
  }

  loadHostConfig(): HostConfig | null {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(this.dir, "host-config.json"), "utf8"));
      return cfg && Array.isArray(cfg.shortcuts) ? (cfg as HostConfig) : null;
    } catch {
      return null;
    }
  }

  saveHostConfig(cfg: HostConfig) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      writeAtomic(path.join(this.dir, "host-config.json"), JSON.stringify(cfg, null, 2) + "\n");
    } catch (e) {
      this.logger.write(`error [ConfigStore] Failed to save host-config.json: ${(e as Error).message}`);
    }
  }
}

export function writeAtomic(file: string, contents: string, mode?: number) {
  const tmp = `${file}.writing`;
  fs.writeFileSync(tmp, contents, mode != null ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

// The league shown in the bar (EE2 config key `leagueId`).
export function leagueFromConfig(contents: string | null): string | null {
  if (!contents) return null;
  try {
    const cfg = JSON.parse(contents);
    return typeof cfg.leagueId === "string" ? cfg.leagueId : null;
  } catch {
    return null;
  }
}
