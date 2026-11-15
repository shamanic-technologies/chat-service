/**
 * The caller's `responseSchema` is a CONTRACT, checked on every answer (SCHEMA-HONOURED-1115).
 *
 * Scripts act on the fields they get back: the lead answerer sends `message` to a prospect as the email body.
 * Provider-side enforcement is NOT a guarantee. Prod 2026-11-15: GLM-5.3 Flash answered the lead answerer
 * with empty objects and a `message` beside `decision: later`; DeepSeek never received the schema at all when
 * the caller's prompt already said "JSON" (0/5 conforming on a live probe); Kimi K3 and GPT Terra dropped a
 * required key 10/10 on a rich schema. Every one of those was served as a 200 because the parse only checked
 * that the text was JSON.
 *
 * So the parsed answer is validated against the schema the CALLER sent (not a provider-normalized copy: the
 * contract is the caller's), and a mismatch is a vendor failure surfaced as 502 with every violation named.
 * Only the SHAPE is checked: types, required keys, enums, bounds, extra keys where the schema forbids them.
 * The CONTENT of a writer's text is never judged (owner rule: a writer model is trusted). `format` is an
 * annotation, as JSON Schema 2020-12 itself says, so it is not asserted. No retry, no default filled in,
 * no fallback model: the caller gets the failure and decides.
 *
 * A schema that cannot be compiled (a `$ref` to nowhere) is refused 400 BEFORE any spend: an answer could
 * never be checked against it.
 */
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { ModelJsonOutputError } from "./json-output.js";

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
const cache = new Map<string, ValidateFunction>();

export class ResponseSchemaInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResponseSchemaInvalidError";
  }
}

export class ModelSchemaMismatchError extends ModelJsonOutputError {
  readonly violations: string[];
  constructor(violations: string[]) {
    super(`Model answer does not follow the responseSchema: ${violations.join("; ")}`);
    this.name = "ModelSchemaMismatchError";
    this.violations = violations;
  }
}

function engineFor(schema: Record<string, unknown>): Ajv | Ajv2020 {
  const dialect = typeof schema.$schema === "string" ? schema.$schema : "";
  return /2019-09|2020-12/.test(dialect) ? draft2020 : draft07;
}

/** Compile (cached) the caller's schema. Throws `ResponseSchemaInvalidError` when it cannot be compiled. */
export function compileResponseSchema(schema: Record<string, unknown>): ValidateFunction {
  const key = JSON.stringify(schema);
  const hit = cache.get(key);
  if (hit) return hit;
  const { $schema: _dialect, $id: _id, ...body } = schema;
  let validate: ValidateFunction;
  try {
    validate = engineFor(schema).compile(body);
  } catch (err) {
    throw new ResponseSchemaInvalidError(
      `responseSchema cannot be compiled, so no answer could be checked against it: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(key, validate);
  return validate;
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

/** Throws `ModelSchemaMismatchError` naming every violation when `value` does not follow `schema`. */
export function assertFollowsResponseSchema(value: unknown, schema: Record<string, unknown>): void {
  const validate = compileResponseSchema(schema);
  if (validate(value)) return;
  const all = (validate.errors ?? []).map(describe);
  const unique = [...new Set(all)];
  const shown = unique.slice(0, MAX_VIOLATIONS);
  if (unique.length > shown.length) shown.push(`and ${unique.length - shown.length} more`);
  throw new ModelSchemaMismatchError(shown.length > 0 ? shown : ["(no detail from the validator)"]);
}
