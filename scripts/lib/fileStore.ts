// Saved-call store on disk for command-line runs (.cache/calls, git-ignored).
import fs from "node:fs";
import path from "node:path";
import type { CallStore, SavedCall } from "../../src/llm/client";
import { REPO_ROOT } from "./env";

export function fileCallStore(dir = path.join(REPO_ROOT, ".cache", "calls")): CallStore {
  fs.mkdirSync(dir, { recursive: true });
  const file = (key: string) => path.join(dir, `${key}.json`);
  return {
    async get(key) {
      try {
        return JSON.parse(fs.readFileSync(file(key), "utf8")) as SavedCall;
      } catch {
        return undefined;
      }
    },
    async set(key, value) {
      fs.writeFileSync(file(key), JSON.stringify(value));
    },
    async clear() {
      for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f));
    },
  };
}
