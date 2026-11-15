/**
 * Does an answer follow the caller's `responseSchema`? MEASURED on every schema'd answer, never a refusal yet
 * (SCHEMA-HONOURED-1115).
 *
 * Scripts act on the fields they get back: the lead answerer sends `message` to a prospect as the email body.
 * Provider-side enforcement is NOT a guarantee. Prod 2026-11-15: GLM-5.3 Flash answered the lead answerer with
 * empty objects and a `message` beside `decision: later`. Live probe 2026-11-16 (rich schema, 10 calls each):
 * Kimi K3 and GPT-6.1 Terra dropped a required key 10/10 while answering 200; DeepSeek never received the schema
 * when the caller's prompt already said "JSON" (0/5).
 *
 * Refusing a non-conforming answer (502) would fail every Kimi K3 / Terra call fleet-wide the day it ships, so
 * enforcement waits for the owner's go (briefer algiers-v1, 2026-11-16). Until then each schema'd answer is
 * checked against the CALLER's schema (never a provider-normalized copy) and counted per day x provider x model x
 * route in `schema_conformance_days`, with the latest violations, served by `GET /internal/schema-conformance`
 * for the dashboard v2 Monitoring chart. The answer is served unchanged either way.
 *
 * Only the SHAPE is checked: types, required keys, enums, bounds, keys the schema forbids. The CONTENT of a
 * writer's text is never judged (owner rule: a writer model is trusted). `format` is an annotation, as JSON
 * Schema 2020-12 itself says, so it is not asserted.
 */
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { sql } from "drizzle-orm";
import type { db as Db } from "../db/index.js";

type Database = typeof Db;

const AJV_OPTIONS = {
  strict: false,
  allErrors: true,
  validateFormats: false,
  logger: false as const,
} as const;

// Draft-07 is the default dialect (Zod-to-JSON-Schema, most callers); a schema that declares 2019-09 /
// 2020-12 is compiled by the 2020 engine. `$schema` itself is dropped before compile so neither engine has
// to resolve a meta-schema it does not ship.
const draft07 = new Ajv(AJV_OPTIONS);
const draft2020 = new Ajv2020(AJV_OPTIONS);

const CACHE_MAX = 500;
const cache = new Map<string, ValidateFunction | { compileError: string }>();

export interface SchemaCheck {
  conforming: boolean;
  /** Each violation in words ("/decision must be one of [...]"); empty when conforming. */
  violations: string[];
}

function engineFor(schema: Record<string, unknown>): Ajv | Ajv2020 {
  const dialect = typeof schema.$schema === "string" ? schema.$schema : "";
  return /2019-09|2020-12/.test(dialect) ? draft2020 : draft07;
}

function compiled(schema: Record<string, unknown>): ValidateFunction | { compileError: string } {
  const key = JSON.stringify(schema);
  const hit = cache.get(key);
  if (hit) return hit;
  const { $schema: _dialect, $id: _id, ...body } = schema;
  let entry: ValidateFunction | { compileError: string };
  try {
    entry = engineFor(schema).compile(body);
  } catch (err) {
    entry = { compileError: err instanceof Error ? err.message : String(err) };
  }
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(key, entry);
  return entry;
}

function describe(e: ErrorObject): string {
  const at = e.instancePath === "" ? "(root)" : e.instancePath;
  const params = e.params as Record<string, unknown>;
  if (e.keyword === "required") return `${at} is missing required key "${String(params.missingProperty)}"`;
  if (e.keyword === "additionalProperties") return `${at} has a key the schema does not allow: "${String(params.additionalProperty)}"`;
  if (e.keyword === "enum") return `${at} must be one of ${JSON.stringify(params.allowedValues)}`;
  return `${at} ${e.message ?? e.keyword}`;
}

const MAX_VIOLATIONS = 8;

/** Checks `value` against the caller's `schema`. A schema that cannot be compiled is reported as such. */
export function checkResponseSchema(value: unknown, schema: Record<string, unknown>): SchemaCheck {
  const validate = compiled(schema);
  if ("compileError" in validate) {
    return { conforming: false, violations: [`responseSchema cannot be compiled: ${validate.compileError}`] };
  }
  if (validate(value)) return { conforming: true, violations: [] };
  const unique = [...new Set((validate.errors ?? []).map(describe))];
  const shown = unique.slice(0, MAX_VIOLATIONS);
  if (unique.length > shown.length) shown.push(`and ${unique.length - shown.length} more`);
  return { conforming: false, violations: shown.length > 0 ? shown : ["(no detail from the validator)"] };
}

/** The answer was not even JSON: counted as a non-conforming answer of that model. */
export const NOT_JSON: SchemaCheck = { conforming: false, violations: ["(root) is not a JSON value"] };

export type SchemaRoute = "complete" | "platform-complete" | "lead-turn";

export interface SchemaConformanceEvent {
  provider: string;
  model: string;
  route: SchemaRoute;
  check: SchemaCheck;
  at?: Date;
}

function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Counts one schema'd answer in the daily series. Fire-and-forget beside the call: a failed write is logged,
 * the caller's answer never waits on it nor fails because of it.
 */
export function recordSchemaConformance(database: Database, event: SchemaConformanceEvent): void {
  const at = event.at ?? new Date();
  const nonConforming = event.check.conforming ? 0 : 1;
  const violations = event.check.conforming ? null : event.check.violations.join("; ");
  if (!event.check.conforming) {
    console.warn(
      `[schema-conformance] ${event.provider}/${event.model} (${event.route}) answer does not follow the responseSchema: ${violations}`,
    );
  }
  // `.then` so a synchronous throw of the driver lands in the same catch: a measurement never breaks the call.
  Promise.resolve()
    .then(() => database.execute(sql`
      INSERT INTO schema_conformance_days (day, provider, model, route, answered_calls, non_conforming_calls, last_violations, last_non_conforming_at)
      VALUES (${utcDay(at)}::date, ${event.provider}, ${event.model}, ${event.route}, 1, ${nonConforming}, ${violations},
              ${nonConforming ? at.toISOString() : null}::timestamptz)
      ON CONFLICT (day, provider, model, route) DO UPDATE SET
        answered_calls = schema_conformance_days.answered_calls + 1,
        non_conforming_calls = schema_conformance_days.non_conforming_calls + EXCLUDED.non_conforming_calls,
        last_violations = COALESCE(EXCLUDED.last_violations, schema_conformance_days.last_violations),
        last_non_conforming_at = COALESCE(EXCLUDED.last_non_conforming_at, schema_conformance_days.last_non_conforming_at)`))
    .catch((err) => console.error(`[schema-conformance] could not record ${event.provider}/${event.model}:`, err));
}

export interface SchemaConformanceDayRow {
  day: string;
  provider: string;
  model: string;
  route: SchemaRoute;
  answeredCalls: number;
  nonConformingCalls: number;
  lastViolations: string | null;
  lastNonConformingAt: string | null;
}

/** A model is BROKEN on the window when more than this share of its schema'd answers missed the schema. */
export const BROKEN_NON_CONFORMING_SHARE = 0.05;
/** Below this many answers in the window, a model is "not enough answers yet", never red. */
export const MIN_ANSWERS_FOR_VERDICT = 20;

export interface ModelConformance {
  provider: string;
  model: string;
  answeredCalls: number;
  nonConformingCalls: number;
  conformingShare: number;
  verdict: "ok" | "broken" | "not_enough_answers";
  sentence: string;
  lastViolations: string | null;
  lastNonConformingAt: string | null;
}

/** The staff read: per model on the window (worst first), and the day series behind the chart. */
export function buildSchemaConformanceRead(rows: SchemaConformanceDayRow[], days: number) {
  const byModel = new Map<string, ModelConformance>();
  for (const r of rows) {
    const key = `${r.provider}\u0000${r.model}`;
    const m = byModel.get(key) ?? {
      provider: r.provider,
      model: r.model,
      answeredCalls: 0,
      nonConformingCalls: 0,
      conformingShare: 1,
      verdict: "not_enough_answers" as const,
      sentence: "",
      lastViolations: null,
      lastNonConformingAt: null,
    };
    m.answeredCalls += r.answeredCalls;
    m.nonConformingCalls += r.nonConformingCalls;
    if (r.lastNonConformingAt && (!m.lastNonConformingAt || r.lastNonConformingAt > m.lastNonConformingAt)) {
      m.lastNonConformingAt = r.lastNonConformingAt;
      m.lastViolations = r.lastViolations;
    }
    byModel.set(key, m);
  }
  const models = [...byModel.values()].map((m) => {
    const share = m.answeredCalls === 0 ? 1 : (m.answeredCalls - m.nonConformingCalls) / m.answeredCalls;
    const verdict: ModelConformance["verdict"] =
      m.answeredCalls < MIN_ANSWERS_FOR_VERDICT ? "not_enough_answers" : 1 - share > BROKEN_NON_CONFORMING_SHARE ? "broken" : "ok";
    const pct = Math.round(share * 1000) / 10;
    const sentence =
      verdict === "broken"
        ? `${m.provider}/${m.model}: ${m.nonConformingCalls} of ${m.answeredCalls} answers in ${days} days did not follow the caller's schema (${pct}% followed it).`
        : verdict === "ok"
          ? `${m.provider}/${m.model}: ${pct}% of ${m.answeredCalls} answers followed the caller's schema.`
          : `${m.provider}/${m.model}: ${m.answeredCalls} schema'd answers so far, not enough to judge.`;
    return { ...m, conformingShare: share, verdict, sentence };
  });
  const rank = { broken: 0, ok: 1, not_enough_answers: 2 } as const;
  models.sort((a, b) => rank[a.verdict] - rank[b.verdict] || a.conformingShare - b.conformingShare);
  const verdict = models.some((m) => m.verdict === "broken") ? "broken" : "ok";
  return { days, verdict, models, series: rows.map(({ lastViolations: _v, lastNonConformingAt: _a, ...r }) => r) };
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown }).rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

export async function loadSchemaConformanceRows(database: Database, days: number, now: Date = new Date()): Promise<SchemaConformanceDayRow[]> {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const from = new Date(today - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const rows = rowsOf(await database.execute(sql`
    SELECT day::text AS day, provider, model, route, answered_calls, non_conforming_calls, last_violations, last_non_conforming_at
    FROM schema_conformance_days WHERE day >= ${from}::date ORDER BY day, provider, model, route`));
  return rows.map((r) => ({
    day: String(r.day),
    provider: String(r.provider),
    model: String(r.model),
    route: String(r.route) as SchemaRoute,
    answeredCalls: Number(r.answered_calls),
    nonConformingCalls: Number(r.non_conforming_calls),
    lastViolations: r.last_violations == null ? null : String(r.last_violations),
    lastNonConformingAt: r.last_non_conforming_at == null ? null : new Date(String(r.last_non_conforming_at)).toISOString(),
  }));
}
