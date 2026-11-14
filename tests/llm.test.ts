import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { costOf, createLLM, extractJson, LLMError, memoryStore, UsageTracker, type CallStore } from "../src/llm/client";
import { MODELS } from "../src/config/models";

const schema = z.object({ answer: z.string() });
const reply = (text: string, usage: Partial<Record<string, number>> = {}, extra: object = {}) =>
  new Response(JSON.stringify({ content: [{ type: "thinking", thinking: "…" }, { type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 20, ...usage }, ...extra }), { status: 200 });
const error = (status: number, message: string, headers: Record<string, string> = {}, type = "error") =>
  new Response(JSON.stringify({ type: "error", error: { type, message } }), { status, headers });

function setup(responses: (() => Response | Promise<Response>)[], opts: { store?: CallStore; concurrency?: number; key?: string | null } = {}) {
  const calls: any[] = [];
  const waits: number[] = [];
  const fetchFn = vi.fn(async (_url: any, init: any) => {
    calls.push({ headers: init.headers, body: JSON.parse(init.body) });
    const next = responses.shift();
    if (!next) throw new Error("unexpected call");
    return next();
  });
  const llm = createLLM({
    apiKey: () => (opts.key === undefined ? "sk-ant-test" : opts.key),
    store: opts.store ?? memoryStore(),
    fetchFn: fetchFn as any,
    sleep: async (ms) => void waits.push(ms),
    browser: true,
    concurrency: opts.concurrency,
    onThrottle: () => {},
  });
  return { llm, calls, waits, fetchFn };
}
const req = (text = "question") => ({ task: "fullReading" as const, system: [{ text: "shared instructions", cache: true }], user: [{ text }], schema });

describe("extractJson", () => {
  it("reads the last <json> block, code fences and bare objects", () => {
    expect(extractJson('thinking… <json>{"a":0}</json> final: <json>\n{"a":1}\n</json>')).toEqual({ a: 1 });
    expect(extractJson('<json>```json\n{"a":2}\n```</json>')).toEqual({ a: 2 });
    expect(extractJson('Here you go: {"a":3} thanks')).toEqual({ a: 3 });
    expect(() => extractJson("no object here")).toThrow();
  });
});

describe("callLLM", () => {
  it("sends the documented request and returns validated data with usage and cost", async () => {
    const { llm, calls } = setup([() => reply('<json>{"answer":"yes"}</json>', { cache_creation_input_tokens: 1000, cache_read_input_tokens: 5000 })]);
    const r = await llm.call(req());
    expect(r.data).toEqual({ answer: "yes" });
    expect(r.fromSavedCache).toBe(false);
    expect(r.usage).toEqual({ input: 100, cacheWrite: 1000, cacheRead: 5000, output: 20 });
    expect(r.cost).toBeCloseTo((100 * 0.1 + 1000 * 0.125 + 5000 * 0.01 + 20 * 0.5) / 1e6, 12);
    const { headers, body } = calls[0];
    expect(headers["x-api-key"]).toBe("sk-ant-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
    expect(body.model).toBe(MODELS.haiku.id);
    expect(body.output_config).toEqual({ effort: "high" });
    expect(body.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(body.messages[0].content[0]).toEqual({ type: "text", text: "question" });
    expect(body.thinking).toBeUndefined();
    expect(body.temperature).toBeUndefined();
  });

  it("uses the model override from the UI toggle", async () => {
    const { llm, calls } = setup([() => reply('<json>{"answer":"x"}</json>')]);
    const r = await llm.call({ ...req(), model: "opus" });
    expect(calls[0].body.model).toBe(MODELS.opus.id);
    expect(r.cost).toBeCloseTo((100 * 4 + 20 * 20) / 1e6, 12);
  });

  it("answers a repeated call from the saved store, free and without calling the API", async () => {
    const tracker = new UsageTracker();
    const { llm, fetchFn } = setup([() => reply('<json>{"answer":"yes"}</json>')]);
    const first = await llm.call({ ...req(), tracker });
    const second = await llm.call({ ...req(), tracker });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(second.fromSavedCache).toBe(true);
    expect(second.cost).toBe(0);
    expect(second.data).toEqual(first.data);
    expect(tracker.byTask.fullReading).toMatchObject({ calls: 1, savedCalls: 1 });
    expect(tracker.totalCost).toBeCloseTo(first.cost, 12);
  });

  it("does not reuse a saved call when the prompt or the model changes", async () => {
    const { llm, fetchFn } = setup([() => reply('<json>{"answer":"a"}</json>'), () => reply('<json>{"answer":"b"}</json>'), () => reply('<json>{"answer":"c"}</json>')]);
    await llm.call(req("one"));
    await llm.call(req("two"));
    await llm.call({ ...req("one"), model: "opus" });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("asks once for a fix when the reply is not valid, then succeeds", async () => {
    const { llm, calls } = setup([() => reply('<json>{"wrong":1}</json>'), () => reply('<json>{"answer":"fixed"}</json>')]);
    const r = await llm.call(req());
    expect(r.data).toEqual({ answer: "fixed" });
    expect(r.usage.input).toBe(200); // both rounds are counted
    expect(calls[1].body.messages).toHaveLength(3);
    expect(calls[1].body.messages[2].content[0].text).toContain("could not be used");
  });

  it("gives up after a second invalid reply", async () => {
    const { llm } = setup([() => reply("nonsense"), () => reply("still nonsense")]);
    await expect(llm.call(req())).rejects.toMatchObject({ kind: "invalid_output" });
  });

  it("retries with more room when the reply was cut off", async () => {
    const { llm, calls } = setup([() => reply('<json>{"answer":"ye', {}, { stop_reason: "max_tokens" }), () => reply('<json>{"answer":"yes"}</json>')]);
    const r = await llm.call(req());
    expect(r.data).toEqual({ answer: "yes" });
    expect(calls[1].body.max_tokens).toBe(calls[0].body.max_tokens * 2);
    expect(calls[1].body.messages).toHaveLength(1);
  });

  it("backs off and retries when rate limited, honouring retry-after", async () => {
    const { llm, waits } = setup([() => error(429, "slow down", { "retry-after": "7" }), () => error(529, "overloaded"), () => reply('<json>{"answer":"ok"}</json>')]);
    const r = await llm.call(req());
    expect(r.data).toEqual({ answer: "ok" });
    expect(waits).toEqual([7000, 4000]);
  });

  it("retries a network failure", async () => {
    const { llm, waits } = setup([() => Promise.reject(new TypeError("Failed to fetch")), () => reply('<json>{"answer":"ok"}</json>')]);
    expect((await llm.call(req())).data).toEqual({ answer: "ok" });
    expect(waits).toEqual([2000]);
  });

  it("gives up after six tries", async () => {
    const { llm, fetchFn } = setup(Array.from({ length: 6 }, () => () => error(529, "overloaded")));
    await expect(llm.call(req())).rejects.toMatchObject({ kind: "overloaded" });
    expect(fetchFn).toHaveBeenCalledTimes(6);
  });

  it("never retries a bad key or an empty account", async () => {
    const a = setup([() => error(401, "invalid x-api-key")]);
    await expect(a.llm.call(req())).rejects.toMatchObject({ kind: "auth" });
    expect(a.fetchFn).toHaveBeenCalledTimes(1);
    const b = setup([() => error(400, "Your credit balance is too low to access the Anthropic API.")]);
    await expect(b.llm.call(req())).rejects.toMatchObject({ kind: "billing" });
    expect(b.fetchFn).toHaveBeenCalledTimes(1);
  });

  it("fails clearly when there is no key, without calling the API", async () => {
    const { llm, fetchFn } = setup([], { key: null });
    await expect(llm.call(req())).rejects.toMatchObject({ kind: "no_key" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("stops when cancelled", async () => {
    const { llm } = setup([() => reply('<json>{"answer":"x"}</json>')]);
    const controller = new AbortController();
    controller.abort();
    await expect(llm.call({ ...req(), signal: controller.signal })).rejects.toMatchObject({ kind: "aborted" });
  });

  it("never runs more calls at once than the concurrency limit", async () => {
    let active = 0;
    let peak = 0;
    const slow = () => async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return reply('<json>{"answer":"x"}</json>');
    };
    const { llm } = setup(Array.from({ length: 10 }, slow), { concurrency: 3 });
    await Promise.all(Array.from({ length: 10 }, (_, i) => llm.call(req(`q${i}`))));
    expect(peak).toBe(3);
  });
});

describe("warmThenAll", () => {
  it("sends the first call alone, then the rest together", async () => {
    const order: string[] = [];
    let firstDone = false;
    const mk = (name: string, ms: number) => async () => {
      order.push(`start ${name}${firstDone ? "" : " (before first finished)"}`);
      await new Promise((r) => setTimeout(r, ms));
      if (name === "a") firstDone = true;
      return reply('<json>{"answer":"x"}</json>');
    };
    const { llm } = setup([mk("a", 15), mk("b", 1), mk("c", 1)]);
    const results = await llm.warmThenAll(["a", "b", "c"].map((n) => () => llm.call(req(n))));
    expect(results).toHaveLength(3);
    expect(order).toEqual(["start a (before first finished)", "start b", "start c"]);
  });

  it("does not count a saved result as the warm-up", async () => {
    const store = memoryStore();
    const pre = setup([() => reply('<json>{"answer":"saved"}</json>')], { store });
    await pre.llm.call(req("a"));

    let live = 0;
    let firstLiveDone = false;
    const seen: boolean[] = [];
    const mk = () => async () => {
      live++;
      seen.push(firstLiveDone);
      await new Promise((r) => setTimeout(r, 5));
      firstLiveDone = true;
      return reply('<json>{"answer":"x"}</json>');
    };
    const { llm } = setup([mk(), mk(), mk()], { store });
    const results = await llm.warmThenAll(["a", "b", "c", "d"].map((n) => () => llm.call(req(n))));
    expect((results[0] as any).fromSavedCache).toBe(true);
    expect(live).toBe(3);
    expect(seen).toEqual([false, true, true]); // "b" went alone; "c" and "d" waited for it
  });

  it("keeps going when one call fails, but stops at once on a bad key", async () => {
    const ok = setup([() => reply('<json>{"answer":"x"}</json>'), () => error(400, "prompt is too long"), () => reply('<json>{"answer":"z"}</json>')]);
    const results = await ok.llm.warmThenAll(["a", "b", "c"].map((n) => () => ok.llm.call(req(n))));
    expect(results[1]).toBeInstanceOf(LLMError);
    expect((results[2] as any).data).toEqual({ answer: "z" });

    const bad = setup([() => error(401, "invalid x-api-key")]);
    await expect(bad.llm.warmThenAll(["a", "b"].map((n) => () => bad.llm.call(req(n))))).rejects.toMatchObject({ kind: "auth" });
    expect(bad.fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("testKey and cost", () => {
  it("reports a working key and a rejected one", async () => {
    expect(await setup([() => reply("ok")]).llm.testKey()).toEqual({ ok: true });
    expect(await setup([() => error(401, "invalid x-api-key")]).llm.testKey()).toMatchObject({ ok: false, kind: "auth" });
  });
  it("prices each kind of token", () => {
    const u = { input: 1_000_000, cacheWrite: 1_000_000, cacheRead: 1_000_000, output: 1_000_000 };
    expect(costOf("haiku", u)).toBeCloseTo(0.1 + 0.125 + 0.01 + 0.5, 9);
    expect(costOf("opus", u)).toBeCloseTo(4 + 5 + 0.2 + 20, 9);
  });
});
