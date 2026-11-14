// The one place that talks to the Anthropic API (ARCHITECTURE.md §7.4).
// Works in the browser and in Node: everything environment-specific is injected.
import type { z } from "zod";
import { MODELS, TASKS, type Effort, type ModelKey, type TaskKey } from "../config/models";
import { PIPELINE } from "../config/pipeline";

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

// ------------------------------------------------------------------ types

/** A piece of prompt text. `cache: true` marks the end of the part shared by many calls. */
export type PromptBlock = { text: string; cache?: boolean };

export type Usage = { input: number; cacheWrite: number; cacheRead: number; output: number };

export type CallRequest<T> = {
  task: TaskKey;
  /** Overrides the task's default model (the UI toggles use this). */
  model?: ModelKey;
  system: PromptBlock[];
  user: PromptBlock[];
  schema: z.ZodType<T>;
  signal?: AbortSignal;
  tracker?: UsageTracker;
};

export type CallResult<T> = { data: T; usage: Usage; cost: number; model: ModelKey; fromSavedCache: boolean };

export type SavedCall = { data: unknown; usage: Usage; model: ModelKey };

/** Saved results of earlier calls, keyed by the full request. */
export type CallStore = {
  get(key: string): Promise<SavedCall | undefined>;
  set(key: string, value: SavedCall): Promise<void>;
  clear(): Promise<void>;
};

export type LLMErrorKind = "no_key" | "auth" | "billing" | "bad_request" | "overloaded" | "invalid_output" | "aborted";

export class LLMError extends Error {
  constructor(
    public kind: LLMErrorKind,
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "LLMError";
  }
}

export type LLMDeps = {
  apiKey: () => string | null;
  store: CallStore;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** True in a browser: adds the header the API requires for direct browser calls. */
  browser?: boolean;
  concurrency?: number;
  /** Called when the API asks us to slow down, so the UI can say so. */
  onThrottle?: (waitMs: number) => void;
};

// ------------------------------------------------------------------ usage and cost

export function costOf(model: ModelKey, u: Usage): number {
  const p = MODELS[model].price;
  return (u.input * p.input + u.cacheWrite * p.cacheWrite + u.cacheRead * p.cacheRead + u.output * p.output) / 1_000_000;
}

/** `cutOff`: replies that hit the length limit and had to be asked for again with more room. */
export type TaskUsage = Usage & { calls: number; savedCalls: number; cost: number; cutOff: number };

/** Running totals for one run, per task. */
export class UsageTracker {
  byTask: Partial<Record<TaskKey, TaskUsage>> = {};
  private listeners = new Set<() => void>();

  record(task: TaskKey, model: ModelKey, usage: Usage, fromSavedCache: boolean) {
    const t = this.usage(task);
    if (fromSavedCache) {
      t.savedCalls++;
    } else {
      t.calls++;
      t.input += usage.input;
      t.cacheWrite += usage.cacheWrite;
      t.cacheRead += usage.cacheRead;
      t.output += usage.output;
      t.cost += costOf(model, usage);
    }
    for (const l of this.listeners) l();
  }

  private usage(task: TaskKey): TaskUsage {
    return (this.byTask[task] ??= { calls: 0, savedCalls: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, cost: 0, cutOff: 0 });
  }

  recordCutOff(task: TaskKey) {
    this.usage(task).cutOff++;
  }

  get totalCost(): number {
    return Object.values(this.byTask).reduce((a, t) => a + (t?.cost ?? 0), 0);
  }
  get totalCalls(): number {
    return Object.values(this.byTask).reduce((a, t) => a + (t?.calls ?? 0), 0);
  }
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

// ------------------------------------------------------------------ helpers

export function memoryStore(): CallStore {
  const m = new Map<string, SavedCall>();
  return {
    get: async (k) => m.get(k),
    set: async (k, v) => void m.set(k, v),
    clear: async () => m.clear(),
  };
}

async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Pulls the JSON object out of a model reply: the last <json>…</json> block, else the outermost braces. */
export function extractJson(text: string): unknown {
  let body: string | null = null;
  const open = text.lastIndexOf("<json>");
  if (open >= 0) {
    const close = text.indexOf("</json>", open);
    body = text.slice(open + 6, close >= 0 ? close : undefined);
  } else {
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first >= 0 && last > first) body = text.slice(first, last + 1);
  }
  if (body === null) throw new Error("no JSON object found in the reply");
  body = body.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(body);
}

class Semaphore {
  private waiting: (() => void)[] = [];
  private active = 0;
  constructor(private limit: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

const BACKOFF_MS = [2000, 4000, 8000, 16000, 32000];
/** The most room a cut-off reply is given when it is asked for again. */
const MAX_REPLY_TOKENS = 32_000;
export const JSON_INSTRUCTION = "Return only a JSON object inside <json></json> tags.";

type ApiMessage = { role: "user" | "assistant"; content: { type: "text"; text: string; cache_control?: { type: "ephemeral" } }[] };

function toBlocks(blocks: PromptBlock[]) {
  return blocks
    .filter((b) => b.text)
    .map((b) => ({ type: "text" as const, text: b.text, ...(b.cache ? { cache_control: { type: "ephemeral" as const } } : {}) }));
}

// ------------------------------------------------------------------ client

export type LLM = ReturnType<typeof createLLM>;

export function createLLM(deps: LLMDeps) {
  const fetchFn = deps.fetchFn ?? globalThis.fetch.bind(globalThis);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const gate = new Semaphore(deps.concurrency ?? PIPELINE.concurrency);

  /** One HTTP request with retries for overload and network errors. Never retries a bad key. */
  async function post(body: unknown, signal?: AbortSignal): Promise<any> {
    const key = deps.apiKey();
    if (!key) throw new LLMError("no_key", "Add your API key in Settings to run live.");
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": API_VERSION,
    };
    if (deps.browser) headers["anthropic-dangerous-direct-browser-access"] = "true";

    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw new LLMError("aborted", "Cancelled.");
      let res: Response | null = null;
      let networkError: unknown = null;
      try {
        res = await fetchFn(API_URL, { method: "POST", headers, body: JSON.stringify(body), signal });
      } catch (err: any) {
        if (err?.name === "AbortError" || signal?.aborted) throw new LLMError("aborted", "Cancelled.");
        networkError = err;
      }

      if (res?.ok) return res.json();

      let message = networkError ? String((networkError as any)?.message ?? networkError) : `HTTP ${res!.status}`;
      let errorType = "";
      if (res) {
        try {
          const j = await res.json();
          message = j?.error?.message ?? message;
          errorType = j?.error?.type ?? "";
        } catch {
          /* keep the status text */
        }
        const status = res.status;
        if (status === 401 || status === 403) throw new LLMError("auth", "The API key was not accepted. Check it in Settings.", status);
        if (status === 400 && /credit balance|billing/i.test(message)) {
          throw new LLMError("billing", "The API account has no credit left. Add credit, then run again.", status);
        }
        const retryable = status === 429 || status === 529 || status >= 500 || errorType === "overloaded_error";
        if (!retryable) throw new LLMError("bad_request", message, status);
      }

      if (attempt >= BACKOFF_MS.length) throw new LLMError("overloaded", `The API is still unavailable after several tries (${message}).`, res?.status);
      const retryAfter = Number(res?.headers.get("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 60_000) : BACKOFF_MS[attempt];
      deps.onThrottle?.(wait);
      await sleep(wait);
    }
  }

  function usageOf(raw: any): Usage {
    const u = raw?.usage ?? {};
    return {
      input: u.input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      output: u.output_tokens ?? 0,
    };
  }

  const addUsage = (a: Usage, b: Usage): Usage => ({
    input: a.input + b.input,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheRead: a.cacheRead + b.cacheRead,
    output: a.output + b.output,
  });

  function buildBody(model: ModelKey, effort: Effort, maxTokens: number, system: PromptBlock[], messages: ApiMessage[]) {
    return {
      model: MODELS[model].id,
      max_tokens: maxTokens,
      // Effort is the documented control for how much the model reasons (output_config.effort).
      // No `thinking`, temperature, top_p or top_k: these models manage thinking themselves.
      output_config: { effort },
      system: toBlocks(system),
      messages,
    };
  }

  /**
   * One model call that returns validated JSON.
   * - A repeat of an earlier call is answered from the saved-call store, free and at once.
   * - If the reply is not valid JSON for the schema, the model is asked once to fix it.
   */
  async function call<T>(req: CallRequest<T>): Promise<CallResult<T>> {
    const cfg = TASKS[req.task];
    const model = req.model ?? cfg.model;
    const keyMaterial = JSON.stringify({
      model: MODELS[model].id,
      promptVersion: PIPELINE.promptVersion,
      effort: cfg.effort,
      maxTokens: cfg.maxTokens,
      system: req.system,
      user: req.user,
    });
    const key = await sha256(keyMaterial);

    const saved = await deps.store.get(key);
    if (saved) {
      const parsed = req.schema.safeParse(saved.data);
      if (parsed.success) {
        req.tracker?.record(req.task, saved.model, saved.usage, true);
        return { data: parsed.data, usage: saved.usage, cost: 0, model: saved.model, fromSavedCache: true };
      }
    }

    return gate.run(async () => {
      const messages: ApiMessage[] = [{ role: "user", content: toBlocks(req.user) }];
      let usage: Usage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
      let maxTokens = cfg.maxTokens;
      let lastProblem = "";
      for (let round = 0; round < 2; round++) {
        const raw = await post(buildBody(model, cfg.effort, maxTokens, req.system, messages), req.signal);
        usage = addUsage(usage, usageOf(raw));
        const text: string = (raw?.content ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join("");
        try {
          const parsed = req.schema.safeParse(extractJson(text));
          if (parsed.success) {
            await deps.store.set(key, { data: parsed.data, usage, model });
            req.tracker?.record(req.task, model, usage, false);
            return { data: parsed.data, usage, cost: costOf(model, usage), model, fromSavedCache: false };
          }
          lastProblem = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
        } catch (err: any) {
          lastProblem = String(err?.message ?? err);
        }
        if (raw?.stop_reason === "max_tokens") {
          // ran out of room (thinking counts toward the limit): try once more with twice the room
          lastProblem = `the reply was cut off at the ${maxTokens}-token limit`;
          req.tracker?.recordCutOff(req.task);
          maxTokens = Math.min(maxTokens * 2, MAX_REPLY_TOKENS);
        } else {
          messages.push({ role: "assistant", content: [{ type: "text", text: text || "(empty reply)" }] });
          messages.push({
            role: "user",
            content: [{ type: "text", text: `Your reply could not be used: ${lastProblem}. ${JSON_INSTRUCTION}` }],
          });
        }
      }
      req.tracker?.record(req.task, model, usage, false);
      throw new LLMError("invalid_output", `The model's reply could not be read (${lastProblem}).`);
    });
  }

  /**
   * Runs calls that share a cached prefix. A cache entry only exists once the first response
   * has arrived, so the first live call goes alone and the rest follow in parallel.
   * Results come back in the order given; a failed call yields its error instead of throwing.
   */
  async function warmThenAll<R extends { fromSavedCache: boolean }>(
    thunks: (() => Promise<R>)[],
    opts: { alreadyWarm?: boolean } = {},
  ): Promise<(R | LLMError)[]> {
    const results: (R | LLMError)[] = new Array(thunks.length);
    const run = async (i: number): Promise<R | LLMError> => {
      try {
        return (results[i] = await thunks[i]());
      } catch (err) {
        const e = err instanceof LLMError ? err : new LLMError("bad_request", String((err as any)?.message ?? err));
        // a bad key or an empty account fails every call the same way: stop at once
        if (e.kind === "auth" || e.kind === "billing" || e.kind === "no_key" || e.kind === "aborted") throw e;
        return (results[i] = e);
      }
    };
    let i = 0;
    // `alreadyWarm`: an earlier step just wrote this prefix to the cache, so nothing needs to go first
    for (; !opts.alreadyWarm && i < thunks.length; i++) {
      const r = await run(i);
      if (!(r instanceof LLMError) && !r.fromSavedCache) {
        i++;
        break; // the cache is warm now
      }
    }
    await Promise.all(thunks.slice(i).map((_, k) => run(i + k)));
    return results;
  }

  /** A tiny call to check that the key works. */
  async function testKey(): Promise<{ ok: true } | { ok: false; kind: LLMErrorKind; message: string }> {
    try {
      await post({ model: MODELS.haiku.id, max_tokens: 16, output_config: { effort: "low" }, messages: [{ role: "user", content: "Reply with the word ok." }] });
      return { ok: true };
    } catch (err) {
      const e = err instanceof LLMError ? err : new LLMError("bad_request", String((err as any)?.message ?? err));
      return { ok: false, kind: e.kind, message: e.message };
    }
  }

  return { call, warmThenAll, testKey, clearSaved: () => deps.store.clear() };
}
