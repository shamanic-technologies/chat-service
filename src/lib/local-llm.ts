// ---------------------------------------------------------------------------
// LOCAL-CLAUDE-1116 (owner 2026-11-16): an org's LLM calls run on the user's
// OWN Claude Code subscription, on their machine, so the user spends $0 on LLM.
// « Ce qui est critique est que le user dépense $0, car tout depuis sa
// subscription Claude Code. Pas de forfait API. »
//
// How: an org DECLARES it (PUT /orgs/local-llm). From then on every text
// completion, structured completion, judgment and chat round chat-service would
// send to a vendor for that org becomes a WORK ITEM in `local_llm_jobs`. A
// runner on the user's machine (the distribute.you Mac app), authenticated with
// the user's distribute key, claims items (POST /orgs/local-llm/work/claim),
// runs each with `claude -p` exactly as described in the item, and posts the
// answer back (POST /orgs/local-llm/work/:id/result). The caller waits for it.
//
// Rules this file holds:
// - The runner is DUMB: an item carries everything one `claude -p` call needs
//   (system prompt, prompt, JSON schema, model, built-in tools). Every
//   translation (a judgment's typed questions, a chat round's tools) happens HERE.
// - Never a platform key for a declaring org: a runner that is away makes the
//   call WAIT, then fail with a NAMED state (`local_runner_waiting`), never a
//   fallback to a vendor (the $0 promise).
// - $0 to the org: no cost hold, no affordability check, nothing charged. Each
//   answer is still STATED on its run (LOCAL-CLAUDE-RATING-1116): the Claude
//   model that ran, its tokens, under that model's own catalog names, as
//   `costSource: "org"` (the org's own provider account: runs-service and
//   billing never charge it, like a BYOK key). So the Rating credits the model
//   that actually wrote, at its list price, never the model the script stated.
// - The answer names the model the CLI says ran, never the model asked for.
// - Nothing goes to claude-haiku-4-5 (owner rule): never asked, refused if reported.
// ---------------------------------------------------------------------------

import { capabilityTierFor, resolveModel, type CapabilityTier, type ModelAlias, type Provider } from "./anthropic.js";
import { anthropicCostLines } from "./anthropic-usage.js";
import { dynastyOfModel, isOnTrial } from "./llm-dynasties.js";
import { isVendorProvider } from "./openai-compatible.js";
import { providerHasNoPlatformKey } from "./platform-key-presence.js";
import type { CostItem } from "./runs-client.js";
import type { LocalAnswerOutcome, LocalJobKind, LocalJobRow, LocalLlmStore, LocalUsage } from "./local-llm-store.js";
import type { TypeSafeAnswer, TypeSafeCriterion, TypeSafeQuestion } from "./typesafe.js";

// --- timing (env-tunable, bounded) -------------------------------------------

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`[local-llm] ${name} must be a positive number of ms (got "${raw}")`);
  return n;
}

/** How long a call waits for the runner to PICK IT UP before failing `local_runner_waiting`. */
export const pickupWaitMs = () => envMs("LOCAL_LLM_PICKUP_WAIT_MS", 45_000);
/** How long a picked-up call may run on the user's machine before failing `local_runner_timeout`. */
export const answerWaitMs = () => envMs("LOCAL_LLM_ANSWER_WAIT_MS", 240_000);
/** A runner that claimed within this window is shown as connected. */
export const RUNNER_CONNECTED_WITHIN_MS = 60_000;
/** Longest a claim request may hold the connection open waiting for work. */
export const CLAIM_MAX_WAIT_MS = 25_000;
export const CLAIM_DEFAULT_WAIT_MS = 20_000;
export const CLAIM_MAX_ITEMS = 10;
const POLL_EVERY_MS = 250;

// --- the work item (the runner's contract) --------------------------------------

/** Everything ONE `claude -p` call needs. The runner maps it to flags, nothing else. */
export interface LocalClaudeCall {
  /** → `--system-prompt` (verbatim). */
  systemPrompt: string;
  /** → the prompt argument of `claude -p` (verbatim). */
  prompt: string;
  /** → `--json-schema` (JSON-encoded) when not null; the answer is then the CLI's `structured_output`. */
  jsonSchema: Record<string, unknown> | null;
  /** → `--model` (a full Claude model id). */
  model: string;
  /** → `--tools` / `--allowedTools`: Claude Code BUILT-IN tools this call may use; [] = `--tools ""`. */
  tools: string[];
}

export interface LocalWorkItem {
  id: string;
  leaseId: string;
  kind: LocalJobKind;
  /** Post the answer before this instant; after it the caller has given up (410). */
  answerBy: string;
  claude: LocalClaudeCall;
}

/** What the runner sends back, already validated by the route's schema. */
export interface LocalRunnerAnswer {
  ok: boolean;
  model?: string | undefined;
  text?: string | undefined;
  structured?: unknown;
  error?: string | undefined;
  usage?: {
    inputTokens?: number | undefined;
    outputTokens?: number | undefined;
    cacheReadTokens?: number | undefined;
    cacheWriteTokens?: number | undefined;
  } | undefined;
  notionalCostUsd?: number | undefined;
  durationMs?: number | undefined;
}

/** A finished local call, as the caller reads it. */
export interface LocalAnswer {
  jobId: string;
  /** The model the CLI says wrote the answer. */
  model: string;
  text: string | null;
  structured: unknown;
  usage: LocalUsage;
}

// --- named failures -------------------------------------------------------------

export type LocalFailureCode = "local_runner_waiting" | "local_runner_timeout" | "local_runner_failed";

export class LocalRunnerError extends Error {
  constructor(
    readonly code: LocalFailureCode,
    message: string,
    readonly jobId: string,
    readonly runnerLastSeenAt: Date | null,
  ) {
    super(message);
    this.name = "LocalRunnerError";
  }
}

/** HTTP answer for a failed local call: a named state, never a generic 5xx. */
export function localFailureResponse(err: LocalRunnerError): { status: number; body: Record<string, unknown> } {
  const status = err.code === "local_runner_failed" ? 502 : err.code === "local_runner_timeout" ? 504 : 503;
  return {
    status,
    body: {
      error: err.message,
      code: err.code,
      retryable: err.code !== "local_runner_failed",
      jobId: err.jobId,
      runnerLastSeenAt: err.runnerLastSeenAt?.toISOString() ?? null,
      servedBy: "local-claude-code",
    },
  };
}

/** What the person reads in the chat when their runner is away (no internal words). */
export function localFailureChatMessage(err: LocalRunnerError): string {
  if (err.code === "local_runner_waiting") {
    return "Your AI runs on your own Claude Code, and the distribute.you app on your computer is not connected right now. Open the app (signed in to Claude Code) and send your message again.";
  }
  if (err.code === "local_runner_timeout") {
    return "Your Claude Code took too long to answer on your computer. Send your message again in a moment.";
  }
  return `Your Claude Code on your computer could not answer: ${err.message}`;
}

// --- the registry of declaring orgs (in memory, loaded from the store) ------------

let store: LocalLlmStore | null = null;
let loaded: Promise<void> | null = null;
const declaredOrgs = new Set<string>();
const REFRESH_EVERY_MS = 30_000;

/** Boot: load the declaring orgs, then refresh every 30 s. Tests inject a memory store. */
export function startLocalLlm(s: LocalLlmStore, opts: { refresh?: boolean } = {}): Promise<void> {
  store = s;
  const load = async () => {
    const ids = await s.listDeclaredOrgIds();
    declaredOrgs.clear();
    for (const id of ids) declaredOrgs.add(id);
  };
  loaded = load();
  if (opts.refresh !== false) {
    const timer = setInterval(() => {
      load().catch((err) => console.error("[local-llm] refresh of declaring orgs failed:", err));
    }, REFRESH_EVERY_MS);
    timer.unref();
  }
  return loaded;
}

/** Tests: forget everything. */
export function resetLocalLlm(): void {
  store = null;
  loaded = null;
  declaredOrgs.clear();
}

export function localLlmStore(): LocalLlmStore {
  if (!store) throw new Error("[local-llm] store not started (startLocalLlm was never called)");
  return store;
}

/**
 * Whether this org's LLM calls go to its local runner. Waits for the boot load,
 * so a declaring org never slips onto a platform key in the first instants
 * after a deploy. No store started (most tests) = nobody declared.
 */
export async function isLocalLlmOrg(orgId: string): Promise<boolean> {
  if (!loaded) return false;
  await loaded;
  return declaredOrgs.has(orgId);
}

export async function declareLocalLlm(orgId: string, declared: boolean, userId: string): Promise<void> {
  await localLlmStore().setDeclared(orgId, declared, userId, new Date());
  if (declared) declaredOrgs.add(orgId);
  else declaredOrgs.delete(orgId);
}

// --- families: what runs locally, what does not (served, so it is never silent) ---

export const LOCAL_FAMILIES = [
  "text completions (/complete)",
  "structured completions (/complete with a JSON schema)",
  "web-grounded completions (the runner's Claude Code WebSearch tool)",
  "judgments (/orgs/judgments, the Copilot's speak-first check)",
  "chat turns with their tools (Sophie in the Copilot, Lead event answers)",
] as const;

/** Families that still run on a platform or vendor key for a declaring org, and why. */
export const NOT_LOCAL_FAMILIES = [
  { family: "image generation", reason: "Claude does not generate images." },
  {
    family: "voice notes sent to an assistant line (/orgs/transcriptions)",
    reason: "short inline audio still runs on a platform model; a long recording runs on our own server through /orgs/media-transcriptions.",
  },
  { family: "embeddings and relevance scoring (/orgs/rag)", reason: "Claude has no embeddings model." },
  { family: "completions and judgments with an image input", reason: "the work item carries text only; the image would need to reach the user's machine." },
  { family: "completions with the brand's own MCP tools (brandTools)", reason: "those tools run on our side with the brand's credentials; not wired to the local runner yet." },
] as const;

/** Families that run on OUR OWN server for every org, declared or not: no vendor is paid (REELS-1124). */
export const ON_OUR_SERVER_FAMILIES = [
  {
    family: "transcription of a long audio or video recording (/orgs/media-transcriptions)",
    reason: "an open speech model on our own server, charged $0.",
  },
] as const;

export interface LocalLlmState {
  declared: boolean;
  declaredAt: string | null;
  declaredByUserId: string | null;
  runner: { connected: boolean; lastSeenAt: string | null; name: string | null; version: string | null };
  pendingCalls: number;
  usageLast30Days: { calls: number; inputTokens: number; outputTokens: number; notionalCostUsd: number; chargedUsd: 0 };
  runsLocally: readonly string[];
  stillOnPlatform: ReadonlyArray<{ family: string; reason: string }>;
  runsOnOurServer: ReadonlyArray<{ family: string; reason: string }>;
}

export async function localLlmState(orgId: string, now = new Date()): Promise<LocalLlmState> {
  const s = localLlmStore();
  const [org, pending, usage] = await Promise.all([
    s.getOrg(orgId),
    s.pendingCount(orgId, now),
    s.usageSince(orgId, new Date(now.getTime() - 30 * 24 * 3600_000)),
  ]);
  const seen = org?.runnerLastSeenAt ?? null;
  return {
    declared: org?.declared === true,
    declaredAt: org?.declared ? (org.declaredAt?.toISOString() ?? null) : null,
    declaredByUserId: org?.declared ? org.declaredByUserId : null,
    runner: {
      connected: seen !== null && now.getTime() - seen.getTime() <= RUNNER_CONNECTED_WITHIN_MS,
      lastSeenAt: seen?.toISOString() ?? null,
      name: org?.runnerName ?? null,
      version: org?.runnerVersion ?? null,
    },
    pendingCalls: pending,
    usageLast30Days: { ...usage, chargedUsd: 0 },
    runsLocally: LOCAL_FAMILIES,
    stillOnPlatform: NOT_LOCAL_FAMILIES,
    runsOnOurServer: ON_OUR_SERVER_FAMILIES,
  };
}

/**
 * LOCAL-CLAUDE-ORGS-1116: the orgs that declared, in one read, so a runner follows a
 * declaration made anywhere (dashboard, MCP, Conductor) within its refresh instead of
 * asking `GET /orgs/local-llm` once per org. Who may SEE which org is the gateway's
 * call (it knows the key's memberships and staff reach); `orgIds` narrows the answer
 * to the orgs it allows, an empty list = none.
 */
export interface DeclaredLocalOrgView {
  orgId: string;
  declaredAt: string | null;
  declaredByUserId: string | null;
  runner: { connected: boolean; lastSeenAt: string | null; name: string | null; version: string | null };
  pendingCalls: number;
}

export async function declaredLocalOrgs(orgIds?: string[], now = new Date()): Promise<DeclaredLocalOrgView[]> {
  const rows = await localLlmStore().listDeclaredOrgs(now, orgIds);
  return rows.map((o) => ({
    orgId: o.orgId,
    declaredAt: o.declaredAt?.toISOString() ?? null,
    declaredByUserId: o.declaredByUserId,
    runner: {
      connected: o.runnerLastSeenAt !== null && now.getTime() - o.runnerLastSeenAt.getTime() <= RUNNER_CONNECTED_WITHIN_MS,
      lastSeenAt: o.runnerLastSeenAt?.toISOString() ?? null,
      name: o.runnerName,
      version: o.runnerVersion,
    },
    pendingCalls: o.pendingCalls,
  }));
}

// --- model choice ------------------------------------------------------------------

const TIER_MODEL: Record<CapabilityTier, string> = {
  cheap: "claude-haiku-5-5",
  strong: "claude-sonnet-5-5",
  frontier: "claude-opus-5-5",
};
/** Owner rule: nothing goes to Haiku 4.5. */
const BANNED_MODEL = /haiku-4-5|haiku-4\.5/i;

/**
 * The Claude model a call asks the runner for: a Claude model the caller named
 * stays itself; any other model maps to the Claude model of its capability tier
 * (the tier is data per alias, never derived from the name).
 */
export function localClaudeModelFor(resolved: { provider: string; apiModelId: string }, provider: Provider, alias: ModelAlias): string {
  if (resolved.provider === "anthropic" && resolved.apiModelId.startsWith("claude-") && !BANNED_MODEL.test(resolved.apiModelId)) {
    return resolved.apiModelId;
  }
  return TIER_MODEL[capabilityTierFor(provider, alias)];
}

/** A judgment asks the cheap tier: classification, input-billed at the vendors it replaces. */
export const LOCAL_JUDGE_MODEL = TIER_MODEL.cheap;

// --- what a local call is stated as (LOCAL-CLAUDE-RATING-1116) ----------------------

/** The Claude model a runner reported, as this service prices it; null = not a model we can name. */
function pricedClaudeModel(modelId: string): { apiModelId: string; costPrefix: string } | null {
  if (BANNED_MODEL.test(modelId)) return null;
  try {
    const r = resolveModel("anthropic", modelId);
    return r.apiModelId === modelId ? { apiModelId: r.apiModelId, costPrefix: r.costPrefix } : null;
  } catch {
    return null;
  }
}

/**
 * The cost lines ONE local answer is stated as on its run: the Claude model the
 * CLI says ran, its tokens under that model's catalog names, `costSource: "org"`
 * (the org's own Claude account: never charged, never held). runs-service prices
 * them at list, so the Rating reads what that writing would cost through a key.
 * Idempotent per job (a retried post never states a call twice).
 */
export function localCostItems(answer: { jobId: string; model: string; usage: LocalUsage }): CostItem[] {
  const priced = pricedClaudeModel(answer.model);
  if (!priced) throw new Error(`[local-llm] job ${answer.jobId}: "${answer.model}" is not a Claude model this service prices`);
  const u = answer.usage;
  if (typeof u.inputTokens !== "number" || typeof u.outputTokens !== "number") {
    throw new Error(`[local-llm] job ${answer.jobId}: the runner reported no token usage, the call cannot be stated`);
  }
  const cacheRead = u.cacheReadTokens ?? 0;
  const cacheWrite = u.cacheWriteTokens ?? 0;
  const lines = anthropicCostLines(priced.costPrefix, {
    tokensInput: u.inputTokens,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    tokensOutput: u.outputTokens,
    // The CLI reports one total per call: the largest prompt is at most this, so a
    // prompt-length tier is never under-stated.
    requestPromptTokens: u.inputTokens + cacheRead + cacheWrite,
  });
  return lines.map((l) => ({ ...l, costSource: "org" as const, status: "actual" as const, idempotencyKey: `local-llm:${answer.jobId}:${l.costName}` }));
}

/** One LLM as a script states it: provider + chat-service LLM dynasty slug (`openai/gpt-sol`). */
export interface ServedLlmAnswer {
  llm: string;
  /** Whether this org's calls on that LLM run on it. null = the LLM is not one this service serves (`error`). */
  runsAsStated: boolean | null;
  /** The model that will run instead / as stated: provider, dynasty slug, model id. Absent when unknown. */
  servedBy?: { llm: string; provider: string; dynasty: string; modelId: string };
  /**
   * Whether the model that runs takes a request with the features asked (`ServedLlmNeeds`), by the same refusal
   * `/complete` applies (the direct-vendor paths are text-only: no web search, no image). Absent when none was asked.
   */
  acceptsRequest?: boolean;
  error?: string;
}

/** Request features a pick must see honoured (WEBSEARCH-PICK-1119): a script whose model refuses them is never drawn. */
export interface ServedLlmNeeds {
  webSearch?: boolean;
  imageUrl?: boolean;
}

/**
 * Which model serves each stated LLM for one org. A non-local org runs every LLM
 * as stated, except one whose provider is known to have no platform key (`runsAsStated: null`). A local org runs a Claude model it names as itself; any other LLM
 * runs on the Claude model of its tier (the same `localClaudeModelFor` the calls use).
 */
export function servedLlmsFor(
  llms: readonly string[],
  local: boolean,
  needs: ServedLlmNeeds = {},
  hasNoPlatformKey: (provider: string) => boolean = providerHasNoPlatformKey,
): ServedLlmAnswer[] {
  const asked = needs.webSearch === true || needs.imageUrl === true;
  return llms.map((llm) => {
    const slash = llm.indexOf("/");
    const provider = slash > 0 ? llm.slice(0, slash) : "";
    const model = slash > 0 ? llm.slice(slash + 1) : "";
    if (!provider || !model) return { llm, runsAsStated: null, error: "Expected provider/model, e.g. openai/gpt-sol" };
    let resolved;
    try {
      resolved = resolveModel(provider as Provider, model);
    } catch (err) {
      return { llm, runsAsStated: null, error: err instanceof Error ? err.message : String(err) };
    }
    // OPEN-LLM-FREE-1124: a provider known to have no platform key serves nothing, so the script naming it is
    // never drawn. (A local org's call runs on its own Claude Code: no platform key involved.)
    if (!local && hasNoPlatformKey(resolved.provider)) {
      return { llm, runsAsStated: null, error: `no platform key for ${resolved.provider}` };
    }
    // OPENROUTER-TRIAL-1125: a line on trial is never drawn for a real send (staff call it by name only).
    if (isOnTrial(resolved.apiModelId)) {
      return { llm, runsAsStated: null, error: `${resolved.apiModelId} is on trial: not live for real sends until the owner's go` };
    }
    const modelId = local ? localClaudeModelFor(resolved, provider as Provider, model) : resolved.apiModelId;
    const servedProvider = local ? "anthropic" : resolved.provider;
    const dynasty = dynastyOfModel(modelId);
    if (!dynasty) throw new Error(`[local-llm] model "${modelId}" has no LLM dynasty recorded`);
    // A local org's call goes to its runner (Claude, web search included) unless it carries an image, which the
    // runner does not take: that call runs on the model as resolved (the /complete local gate).
    const runsOn = local && needs.imageUrl !== true ? "anthropic" : resolved.provider;
    return {
      llm,
      runsAsStated: modelId === resolved.apiModelId,
      servedBy: { llm: `${servedProvider}/${dynasty.slug}`, provider: servedProvider, dynasty: dynasty.slug, modelId },
      ...(asked ? { acceptsRequest: !isVendorProvider(runsOn) } : {}),
    };
  });
}

// --- enqueue + wait ------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Hands one call to the org's runner and waits for its answer. Throws a named
 * `LocalRunnerError` when nobody picks it up in time, when the runner takes too
 * long, or when the runner reports a failure. Never calls a vendor.
 */
export async function runLocally(args: {
  orgId: string;
  kind: LocalJobKind;
  route: string;
  runId: string | null;
  call: LocalClaudeCall;
  signal?: AbortSignal;
}): Promise<LocalAnswer> {
  if (BANNED_MODEL.test(args.call.model)) throw new Error(`[local-llm] refusing to ask for ${args.call.model} (owner rule)`);
  const s = localLlmStore();
  const now = Date.now();
  const job = await s.enqueue({
    orgId: args.orgId,
    kind: args.kind,
    route: args.route,
    runId: args.runId,
    request: args.call,
    pickupDeadlineAt: new Date(now + pickupWaitMs()),
    answerDeadlineAt: new Date(now + pickupWaitMs() + answerWaitMs()),
  });
  console.log(`[local-llm] org="${args.orgId}" job="${job.id}" kind=${args.kind} route=${args.route} model=${args.call.model} queued`);

  for (;;) {
    const current = await s.getJob(job.id);
    if (!current) throw new Error(`[local-llm] job ${job.id} vanished`);
    if (current.status === "done" || current.status === "failed" || current.status === "expired") {
      return finished(current);
    }
    const t = new Date();
    const deadline = current.status === "pending" ? current.pickupDeadlineAt : current.answerDeadlineAt;
    if (args.signal?.aborted || t >= deadline) {
      const code: LocalFailureCode = current.status === "pending" ? "local_runner_waiting" : "local_runner_timeout";
      const reason = args.signal?.aborted ? "caller_left" : code;
      if (await s.expire(job.id, reason, t)) {
        const org = await s.getOrg(args.orgId);
        console.warn(`[local-llm] org="${args.orgId}" job="${job.id}" ${code} (runner last seen ${org?.runnerLastSeenAt?.toISOString() ?? "never"})`);
        throw new LocalRunnerError(
          code,
          code === "local_runner_waiting"
            ? `Waiting for the local runner: this org's LLM runs on the user's own Claude Code, and no runner picked up the call within ${Math.round(pickupWaitMs() / 1000)} s.`
            : `The local runner picked up the call but sent no answer within ${Math.round(answerWaitMs() / 1000)} s.`,
          job.id,
          org?.runnerLastSeenAt ?? null,
        );
      }
      continue; // answered between our read and the expire: read it
    }
    await sleep(POLL_EVERY_MS);
  }
}

function finished(job: LocalJobRow): LocalAnswer {
  if (job.status === "done") {
    const r = (job.result ?? {}) as { text?: unknown; structured?: unknown };
    return {
      jobId: job.id,
      model: job.model ?? "unknown",
      text: typeof r.text === "string" ? r.text : null,
      structured: r.structured ?? null,
      usage: job.usage,
    };
  }
  if (job.status === "failed") {
    throw new LocalRunnerError("local_runner_failed", job.error ?? "The local runner reported a failure.", job.id, null);
  }
  throw new LocalRunnerError("local_runner_timeout", `The local call ended: ${job.error ?? "expired"}.`, job.id, null);
}

/** Turns the runner's posted answer into what is stored; refuses what cannot be served. */
export function answerOutcome(job: LocalJobRow, a: LocalRunnerAnswer): LocalAnswerOutcome {
  const usage: LocalUsage = {
    inputTokens: a.usage?.inputTokens ?? null,
    outputTokens: a.usage?.outputTokens ?? null,
    cacheReadTokens: a.usage?.cacheReadTokens ?? null,
    cacheWriteTokens: a.usage?.cacheWriteTokens ?? null,
    notionalCostUsd: a.notionalCostUsd ?? null,
    durationMs: a.durationMs ?? null,
  };
  const model = a.model ?? null;
  if (!a.ok) return { ok: false, error: a.error ?? "The local runner reported a failure without a message.", model, usage };
  if (!model) return { ok: false, error: "The runner's answer did not say which model wrote it (the CLI's init `model`).", model, usage };
  if (BANNED_MODEL.test(model)) return { ok: false, error: `The answer was written by ${model}, a model we never use (owner rule).`, model, usage };
  if (!pricedClaudeModel(model)) return { ok: false, error: `The answer was written by "${model}", not a Claude model this service prices: the call could not be credited to the model that ran.`, model, usage };
  if (typeof usage.inputTokens !== "number" || typeof usage.outputTokens !== "number") {
    return { ok: false, error: "The answer carries no token usage (`usage.inputTokens` + `usage.outputTokens`, the CLI's result usage): the call could not be stated on its run.", model, usage };
  }
  const call = job.request as LocalClaudeCall;
  if (call.jsonSchema) {
    if (a.structured === undefined || a.structured === null) {
      return { ok: false, error: "The call asked for a JSON schema and the answer carries no `structured` value (the CLI's structured_output).", model, usage };
    }
    return { ok: true, result: { structured: a.structured }, model, usage };
  }
  if (typeof a.text !== "string") return { ok: false, error: "The answer carries no `text` (the CLI's result).", model, usage };
  return { ok: true, result: { text: a.text }, model, usage };
}

export function toWorkItem(job: LocalJobRow): LocalWorkItem {
  return {
    id: job.id,
    leaseId: job.leaseId!,
    kind: job.kind,
    answerBy: job.answerDeadlineAt.toISOString(),
    claude: job.request as LocalClaudeCall,
  };
}

/** Long-poll claim: returns as soon as work exists, or empty after `waitMs`. Marks the runner seen. */
export async function claimWork(
  orgId: string,
  opts: { max: number; waitMs: number; runner: { name: string | null; version: string | null }; signal?: AbortSignal },
): Promise<LocalWorkItem[]> {
  const s = localLlmStore();
  const until = Date.now() + Math.min(opts.waitMs, CLAIM_MAX_WAIT_MS);
  for (;;) {
    const now = new Date();
    await s.touchRunner(orgId, now, opts.runner);
    const jobs = await s.claim(orgId, Math.min(opts.max, CLAIM_MAX_ITEMS), now);
    if (jobs.length > 0) {
      console.log(`[local-llm] org="${orgId}" runner claimed ${jobs.length} job(s): ${jobs.map((j) => j.id).join(",")}`);
      return jobs.map(toWorkItem);
    }
    if (Date.now() >= until || opts.signal?.aborted) return [];
    await sleep(Math.min(500, Math.max(0, until - Date.now())));
  }
}

// --- translations: a call family → one `claude -p` call --------------------------------

/** /complete: the caller's prompt, byte-equal (Prompt Ownership). */
export function completeCall(args: {
  systemPrompt: string | undefined;
  message: string;
  responseSchema: Record<string, unknown> | null | undefined;
  jsonMode: boolean;
  webSearch: boolean;
  model: string;
}): LocalClaudeCall {
  return {
    systemPrompt: args.systemPrompt ?? "",
    prompt: args.message,
    jsonSchema: args.responseSchema ?? (args.jsonMode ? { type: "object" } : null),
    model: args.model,
    tools: args.webSearch ? ["WebSearch"] : [],
  };
}

const JUDGE_SYSTEM = [
  "You are a careful judge. You read a piece of state and answer typed questions about it.",
  "For every question, give a probability to EACH allowed answer: your honest belief that it is the right one, summing to 1.",
  "Answer only from the state. When the state does not settle a question, spread the probability accordingly.",
].join(" ");

const criterionText = (c: TypeSafeCriterion) => (typeof c === "string" ? c : c.examples?.length ? `${c.what} (e.g. ${c.examples.join("; ")})` : c.what);

/** The allowed answers of a question, as keys and the words they stand for. */
function optionsOf(q: TypeSafeQuestion): Array<{ key: string; meaning: string }> {
  if (q.type === "noul") {
    return [
      { key: "yes", meaning: q.criteria?.true ?? "yes" },
      { key: "no", meaning: q.criteria?.false ?? "no" },
    ];
  }
  if (q.type === "choice") return Object.entries(q.criteria).map(([key, c]) => ({ key, meaning: criterionText(c) }));
  return q.criteria.map((c, i) => ({ key: String(i + 1), meaning: criterionText(c) }));
}

/** /orgs/judgments: typed questions → one structured call asking a distribution per question. */
export function judgmentCall(state: unknown, questions: Record<string, TypeSafeQuestion>): LocalClaudeCall {
  const lines: string[] = ["State:", typeof state === "string" ? state : JSON.stringify(state, null, 2), "", "Questions:"];
  const properties: Record<string, unknown> = {};
  for (const [key, q] of Object.entries(questions)) {
    const opts = optionsOf(q);
    lines.push(`- ${key}: ${q.instructions}`);
    for (const o of opts) lines.push(`    "${o.key}" = ${o.meaning}`);
    properties[key] = {
      type: "object",
      properties: Object.fromEntries(opts.map((o) => [o.key, { type: "number", minimum: 0, maximum: 1 }])),
      required: opts.map((o) => o.key),
      additionalProperties: false,
    };
  }
  lines.push("", "For each question key, give the probability of each allowed answer.");
  return {
    systemPrompt: JUDGE_SYSTEM,
    prompt: lines.join("\n"),
    jsonSchema: { type: "object", properties, required: Object.keys(questions), additionalProperties: false },
    model: LOCAL_JUDGE_MODEL,
    tools: [],
  };
}

/** The local answer → the judgments door's answer objects (same shapes as every judge). */
export function judgmentAnswers(questions: Record<string, TypeSafeQuestion>, structured: unknown): Record<string, TypeSafeAnswer> {
  if (!structured || typeof structured !== "object") throw new Error("[local-llm] judgment answer is not an object");
  const out: Record<string, TypeSafeAnswer> = {};
  for (const [key, q] of Object.entries(questions)) {
    const raw = (structured as Record<string, unknown>)[key];
    if (!raw || typeof raw !== "object") throw new Error(`[local-llm] judgment answer is missing question "${key}"`);
    const opts = optionsOf(q);
    const values = opts.map((o) => (raw as Record<string, unknown>)[o.key]);
    if (!values.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0)) {
      throw new Error(`[local-llm] judgment answer "${key}" does not give a probability to every option`);
    }
    const total = (values as number[]).reduce((s, v) => s + v, 0);
    if (total <= 0) throw new Error(`[local-llm] judgment answer "${key}" gives every option zero`);
    const p = Object.fromEntries(opts.map((o, i) => [o.key, (values[i] as number) / total]));
    if (q.type === "noul") {
      out[key] = { type: "noul", noul: p.yes };
      continue;
    }
    const [bestKey, bestP] = Object.entries(p).sort((a, b) => b[1] - a[1])[0];
    if (q.type === "choice") {
      out[key] = { type: "choice", choice: bestKey, confidence: bestP, probabilities: p };
      continue;
    }
    out[key] = {
      type: "score",
      score: Object.entries(p).reduce((s, [k, v]) => s + Number(k) * v, 0),
      confidence: bestP,
      probabilities: p,
      legend: Object.fromEntries(opts.map((o) => [o.key, o.meaning])),
    };
  }
  return out;
}

// --- a chat round (the /chat tool loop) ---------------------------------------------------

/** One message of a chat round as the vendor loop holds it (OpenAI-compatible). */
export type RoundMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | Array<{ type: string; text?: string }> }
  | { role: "assistant"; content: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }
  | { role: "tool"; tool_call_id: string; content: string };

export interface RoundTool {
  name: string;
  description: string;
  input_schema: { properties?: Record<string, unknown>; required?: string[] };
}

const ROUND_PROTOCOL = [
  "## How you act in this conversation",
  "You never run tools yourself here. Each time, you write ONE step as JSON:",
  '- `toolCalls`: the tools you want run now (name + input matching the tool\'s input schema), in order; their results come back to you in the next step.',
  "- `text`: what you say to the person. Leave it empty while you still need tool results; write your answer once you have what you need, with `toolCalls` empty.",
  "Only call tools listed below, with inputs that follow their schema.",
].join("\n");

function userText(content: RoundMessage["content"]): string {
  if (typeof content === "string") return content;
  const words = content.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
  const photos = content.filter((p) => p.type !== "text").length;
  return photos > 0
    ? `${words}\n(The person also sent ${photos} photo(s). This assistant runs on the person's own Claude Code and cannot see photos here: say so if they matter.)`
    : words;
}

/** A chat round → one structured `claude -p` call: transcript in, `{text, toolCalls}` out. */
export function chatRoundCall(messages: RoundMessage[], tools: RoundTool[], model: string): LocalClaudeCall {
  const [first, ...rest] = messages;
  const baseSystem = first && first.role === "system" ? first.content : "";
  const conversation = first && first.role === "system" ? rest : messages;
  const names = new Map<string, string>();
  const transcript: string[] = [];
  for (const m of conversation) {
    if (m.role === "system") transcript.push(`[context]\n${m.content}`);
    else if (m.role === "user") transcript.push(`[person]\n${userText(m.content)}`);
    else if (m.role === "assistant") {
      if (m.content.trim()) transcript.push(`[you]\n${m.content}`);
      for (const c of m.tool_calls ?? []) {
        names.set(c.id, c.function.name);
        transcript.push(`[you called ${c.function.name}]\n${c.function.arguments || "{}"}`);
      }
    } else transcript.push(`[result of ${names.get(m.tool_call_id) ?? "tool"}]\n${m.content}`);
  }
  const toolList = tools.map((t) =>
    `### ${t.name}\n${t.description}\nInput schema: ${JSON.stringify({ type: "object", properties: t.input_schema.properties ?? {}, required: t.input_schema.required ?? [] })}`,
  );
  const systemPrompt = tools.length > 0
    ? `${baseSystem}\n\n${ROUND_PROTOCOL}\n\n## Tools\n${toolList.join("\n\n")}`
    : baseSystem;
  const prompt = `${transcript.join("\n\n")}\n\n${tools.length > 0 ? "Write your next step as JSON." : "Write your answer to the person."}`;
  return {
    systemPrompt,
    prompt,
    jsonSchema: tools.length > 0
      ? {
          type: "object",
          properties: {
            text: { type: "string" },
            toolCalls: {
              type: "array",
              items: {
                type: "object",
                properties: { name: { type: "string", enum: tools.map((t) => t.name) }, input: { type: "object" } },
                required: ["name", "input"],
              },
            },
          },
          required: ["text", "toolCalls"],
        }
      : null,
    model,
    tools: [],
  };
}

/** The local answer of a chat round → its text and tool calls. */
export function chatRoundAnswer(answer: LocalAnswer, hadTools: boolean): { text: string; toolCalls: Array<{ name: string; input: Record<string, unknown> }> } {
  if (!hadTools) return { text: answer.text ?? "", toolCalls: [] };
  const s = answer.structured as { text?: unknown; toolCalls?: unknown } | null;
  if (!s || typeof s !== "object") throw new Error("[local-llm] chat round answer is not an object");
  const calls = Array.isArray(s.toolCalls) ? s.toolCalls : [];
  return {
    text: typeof s.text === "string" ? s.text : "",
    toolCalls: calls
      .filter((c): c is { name: string; input?: unknown } => !!c && typeof (c as { name?: unknown }).name === "string")
      .map((c) => ({ name: c.name, input: c.input && typeof c.input === "object" && !Array.isArray(c.input) ? (c.input as Record<string, unknown>) : {} })),
  };
}
