import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_HOST_CONFIG } from "../src/app";
import { ConfigStore, leagueFromConfig } from "../src/config-store";
import { Logger } from "../src/logger";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "omaexiled-cfg-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;
const freshDir = () => path.join(root, `c${n++}`);

function logger() {
  const lines: string[] = [];
  const l = new Logger();
  l.write = (m: string) => {
    lines.push(m);
  };
  return { l, lines };
}

const EE2 = path.join(root, "ee2-config.json");
fs.writeFileSync(EE2, JSON.stringify({ configVersion: 34, leagueId: "Rise of the Abyssal" }));

describe("ConfigStore", () => {
  test("load returns null without a config", async () => {
    expect(await new ConfigStore(freshDir(), logger().l).load()).toBeNull();
  });

  test("save writes verbatim, atomically", async () => {
    const dir = freshDir();
    const store = new ConfigStore(dir, logger().l);
    const contents = '{"b": 1,\n "a": [ 2 ]}';
    await store.save(contents, false);
    expect(fs.readFileSync(path.join(dir, "config.json"), "utf8")).toBe(contents);
    expect(fs.existsSync(path.join(dir, "config.json.writing"))).toBe(false);
    expect(await store.load()).toBe(contents);
  });

  test("isTemporary switches to config.json.tmp for the rest of the process", async () => {
    const dir = freshDir();
    const store = new ConfigStore(dir, logger().l);
    await store.save('{"real":true}', false);
    await store.save('{"tmp":1}', true);
    await store.save('{"tmp":2}', false); // still the .tmp file
    expect(fs.readFileSync(path.join(dir, "config.json"), "utf8")).toBe('{"real":true}');
    expect(fs.readFileSync(path.join(dir, "config.json.tmp"), "utf8")).toBe('{"tmp":2}');
    expect(await store.load()).toBe('{"tmp":2}');
  });

  test("invalid JSON is moved aside and served as null", async () => {
    const dir = freshDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.json"), "{ not json");
    const { l, lines } = logger();
    const store = new ConfigStore(dir, l);
    expect(await store.load()).toBeNull();
    const files = fs.readdirSync(dir);
    expect(files).not.toContain("config.json");
    const bad = files.find((f) => /^config\.json\.bad-\d+$/.test(f));
    expect(bad).toBeDefined();
    expect(fs.readFileSync(path.join(dir, bad!), "utf8")).toBe("{ not json");
    expect(lines[0]).toContain("is not valid JSON");
  });

  test("imports EE2's config once", async () => {
    const dir = freshDir();
    const store = new ConfigStore(dir, logger().l, EE2);
    expect(store.importEe2Once()).toBe(true);
    expect(await store.load()).toBe(fs.readFileSync(EE2, "utf8"));
    // deleting config.json later does not import again
    fs.rmSync(path.join(dir, "config.json"));
    expect(new ConfigStore(dir, logger().l, EE2).importEe2Once()).toBe(false);
    expect(fs.existsSync(path.join(dir, "config.json"))).toBe(false);
  });

  test("never overwrites an existing config", async () => {
    const dir = freshDir();
    const store = new ConfigStore(dir, logger().l, EE2);
    await store.save('{"mine":1}', false);
    expect(store.importEe2Once()).toBe(false);
    expect(await store.load()).toBe('{"mine":1}');
  });

  test("no EE2 config: nothing to import", () => {
    expect(new ConfigStore(freshDir(), logger().l, path.join(root, "missing.json")).importEe2Once()).toBe(false);
  });

  test("host-config.json cache round trip", () => {
    const dir = freshDir();
    const store = new ConfigStore(dir, logger().l);
    expect(store.loadHostConfig()).toBeNull();
    store.saveHostConfig(DEFAULT_HOST_CONFIG);
    expect(new ConfigStore(dir, logger().l).loadHostConfig()).toEqual(DEFAULT_HOST_CONFIG);
    fs.writeFileSync(path.join(dir, "host-config.json"), "{broken");
    expect(store.loadHostConfig()).toBeNull();
  });
});

test("leagueFromConfig", () => {
  expect(leagueFromConfig('{"leagueId":"Standard"}')).toBe("Standard");
  expect(leagueFromConfig("{}")).toBeNull();
  expect(leagueFromConfig("nope")).toBeNull();
  expect(leagueFromConfig(null)).toBeNull();
});
