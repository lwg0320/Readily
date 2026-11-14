// Reads the API key for command-line checks: the ANTHROPIC_API_KEY environment variable,
// or a line `ANTHROPIC_API_KEY=...` in .env.local at the repo root (git-ignored).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function readApiKey(): string | null {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY.trim();
  const file = path.join(REPO_ROOT, ".env.local");
  if (!fs.existsSync(file)) return null;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*ANTHROPIC_API_KEY\s*=\s*["']?([^"'\s]+)["']?\s*$/);
    if (m) return m[1];
  }
  return null;
}

export function requireApiKey(): string {
  const key = readApiKey();
  if (!key) {
    console.error(
      [
        "No API key found.",
        "Create a file named .env.local in the repo root containing one line:",
        "  ANTHROPIC_API_KEY=sk-ant-...",
        "The file is git-ignored. Never commit a key or paste it into a chat.",
      ].join("\n"),
    );
    process.exit(1);
  }
  return key;
}
