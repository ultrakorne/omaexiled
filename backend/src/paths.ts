import os from "node:os";
import path from "node:path";

export const VERSION = "0.1.0";

export const DEFAULT_PORT = 8584;

// Runtime locations. Every one can be overridden from the environment so
// tests can run a second backend next to the real one.
export interface Paths {
  port: number;
  configDir: string;
  runtimeDir: string;
  hostBin: string;
  rendererDir: string;
  // EE2's config, imported once into an empty OmaExiled config dir.
  ee2Config: string;
}

export function resolvePaths(env = process.env): Paths {
  const home = os.homedir();
  const repo = path.resolve(import.meta.dir, "../..");
  const xdgConfig = env.XDG_CONFIG_HOME || path.join(home, ".config");
  const xdgRuntime = env.XDG_RUNTIME_DIR || path.join(os.tmpdir(), `runtime-${os.userInfo().uid}`);
  return {
    port: env.OMAEXILED_PORT ? Number(env.OMAEXILED_PORT) : DEFAULT_PORT,
    configDir: env.OMAEXILED_CONFIG_DIR || path.join(xdgConfig, "omaexiled"),
    runtimeDir: env.OMAEXILED_RUNTIME_DIR || path.join(xdgRuntime, "omaexiled"),
    hostBin: env.OMAEXILED_HOST_BIN || path.join(repo, "host/build/omaexiled-host"),
    rendererDir: env.OMAEXILED_RENDERER_DIR || path.join(repo, "renderer/dist"),
    ee2Config:
      env.OMAEXILED_EE2_CONFIG ?? path.join(xdgConfig, "exiled-exchange-2/apt-data/config.json"),
  };
}

// sun_path holds 108 bytes including the NUL.
export function checkSocketPath(p: string) {
  const len = Buffer.byteLength(p);
  if (len > 107) throw new Error(`socket path too long (${len} > 107 bytes): ${p}`);
  return p;
}
