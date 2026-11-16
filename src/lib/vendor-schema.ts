/**
 * Any valid caller schema works on every vendor (SCHEMA-ANY-VENDOR-1116).
 *
 * A caller sends ONE JSON Schema (`responseSchema`). Each vendor accepts its own dialect of it, and refuses
 * the rest with a 400. This module translates the caller's schema into the form each vendor accepts, so a
 * caller is never refused over a vendor's dialect, and the answer reaches the caller exactly as its own schema
 * describes it.
 *
 * Measured live on 2026-11-16 (one schema per keyword, from the chat-service container):
 * - Google (`responseJsonSchema` and function `parametersJsonSchema`) takes JSON Schema as is, including an
 *   enum holding "" — which its older OpenAPI `responseSchema` field refused (`enum[2]: cannot be empty`,
 *   11 of 11 lead-answerer runs on 2026-11-16). It refuses only the draft-07 tuple form `items: [...]` and a
 *   `$ref` the schema cannot resolve (`#/components/...`: "reference to undefined schema").
 * - OpenAI (non-strict json_schema) refuses only the tuple form. Moonshot refuses the tuple form and an
 *   `enum` with no `type` ("type is not defined"). Z.ai answered a 500 to the tuple form.
 * - Anthropic (`output_config.format`, strict) refuses much more: `oneOf`, `not`, `if`, `minimum`/`maximum`/
 *   `exclusiveMinimum`/`multipleOf`, `minProperties`, `maxItems`, `minItems` above 1, `uniqueItems`,
 *   `contains`, `prefixItems`, `patternProperties`, `dependentRequired`, a `format` outside its list,
 *   `additionalProperties` other than false, a node with no type, a recursive `$ref`.
 *
 * Two layers, one per kind of restriction:
 * 1. `toPortableJsonSchema` — LOSSLESS rewrites every vendor that takes JSON Schema accepts: the tuple form
 *    becomes `prefixItems`, an untyped `enum`/`const` gets its type(s), OpenAPI `nullable` becomes a `"null"`
 *    type, a `$ref` that resolves nowhere is dropped (no one can check it). Same instances valid before and
 *    after. Google, OpenAI, Z.ai and Moonshot get this.
 * 2. `toAnthropicJsonSchema` — Anthropic's strict dialect on top: a refused CONSTRAINT keyword moves into the
 *    node's `description` (the model still reads it; what Anthropic's own SDK does), `oneOf` becomes `anyOf`,
 *    local `$ref`s are inlined, every object gets `additionalProperties: false`. A node the dialect cannot
 *    express at all (a free-form map, an untyped value, a recursive or tuple node) is asked for as a
 *    JSON-encoded STRING and decoded back by `decodeSchemaAnswer`, so the caller receives the value its schema describes.
 *
 * The caller's schema is never mutated, and the conformance measure (response-schema.ts) keeps checking the
 * answer against the CALLER's schema, never a translated copy.
 */

type Json = unknown;
type Node = Record<string, unknown>;

function isNode(value: unknown): value is Node {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Keywords whose value is one schema. */
const SCHEMA_KEYWORDS = [
  "additionalProperties",
  "additionalItems",
  "items",
  "not",
  "if",
  "then",
  "else",
  "contains",
  "propertyNames",
  "unevaluatedProperties",
  "unevaluatedItems",
] as const;
/** Keywords whose value is an array of schemas. */
const SCHEMA_ARRAY_KEYWORDS = ["anyOf", "oneOf", "allOf", "prefixItems"] as const;
/** Keywords whose value maps names to schemas (the names are never keywords). */
const SCHEMA_MAP_KEYWORDS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"] as const;

function jsonType(value: Json): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

/** The types an enum's values carry, `integer` folded into `number` when both appear. */
function typesOf(values: Json[]): string[] {
  const types = [...new Set(values.map(jsonType))];
  return types.includes("number") ? types.filter((t) => t !== "integer") : types;
}

/** Resolves a `$ref` inside the schema itself (`#`, `#/$defs/x`, any local JSON pointer). Undefined when it does not. */
export function resolveLocalRef(ref: string, root: Node): unknown {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined;
  let at: unknown = root;
  for (const raw of ref.slice(2).split("/")) {
    const token = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(at) && /^\d+$/.test(token)) at = at[Number(token)];
    else if (isNode(at) && token in at) at = at[token];
    else return undefined;
  }
  return at;
}

function portableNode(value: unknown, root: Node): unknown {
  if (Array.isArray(value)) return value.map((v) => portableNode(v, root));
  if (!isNode(value)) return value;
  const out: Node = {};
  for (const [key, val] of Object.entries(value)) {
    if ((SCHEMA_MAP_KEYWORDS as readonly string[]).includes(key) && isNode(val)) {
      out[key] = Object.fromEntries(Object.entries(val).map(([name, sub]) => [name, portableNode(sub, root)]));
    } else if ((SCHEMA_KEYWORDS as readonly string[]).includes(key) || (SCHEMA_ARRAY_KEYWORDS as readonly string[]).includes(key)) {
      out[key] = portableNode(val, root);
    } else {
      out[key] = val;
    }
  }

  // A `$ref` the schema itself cannot resolve (`#/components/...` from an OpenAPI document, a remote URL)
  // constrains nothing anyone can check, and Google refuses it ("reference to undefined schema"): dropped.
  if (typeof out.$ref === "string" && resolveLocalRef(out.$ref, root) === undefined) delete out.$ref;

  // Draft-07 tuple form `items: [A, B]` (+ `additionalItems`) = draft 2020-12 `prefixItems: [A, B]` (+ `items`).
  if (Array.isArray(out.items)) {
    const tuple = out.items;
    delete out.items;
    if (out.prefixItems === undefined) out.prefixItems = tuple;
    if (out.additionalItems !== undefined) {
      out.items = out.additionalItems;
      delete out.additionalItems;
    }
  }

  // OpenAPI `nullable: true` = JSON Schema `"null"` among the types.
  if (out.nullable === true && out.type !== undefined) {
    const types = Array.isArray(out.type) ? out.type : [out.type];
    out.type = types.includes("null") ? types : [...types, "null"];
    if (Array.isArray(out.enum) && !out.enum.includes(null)) out.enum = [...out.enum, null];
    delete out.nullable;
  }

  // An untyped `enum` / `const` gets the type(s) of its own values. Several types: one branch per type.
  if (out.type === undefined && out.anyOf === undefined && out.oneOf === undefined && out.allOf === undefined && out.$ref === undefined) {
    if (Array.isArray(out.enum) && out.enum.length > 0) {
      const values = out.enum as Json[];
      const types = typesOf(values);
      if (types.length === 1) {
        out.type = types[0];
      } else {
        delete out.enum;
        out.anyOf = types.map((t) => ({
          type: t,
          enum: values.filter((v) => {
            const vt = jsonType(v);
            return vt === t || (t === "number" && vt === "integer");
          }),
        }));
      }
    } else if ("const" in out) {
      out.type = jsonType(out.const);
    }
  }
  return out;
}

/** Lossless rewrites every JSON-Schema vendor accepts. Returns a new schema; the caller's is not mutated. */
export function toPortableJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return portableNode(schema, schema) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Anthropic strict dialect
// ---------------------------------------------------------------------------

/** String formats Anthropic accepts (its docs + the SDK's own list; `phone` was refused live). */
const ANTHROPIC_FORMATS = new Set(["date-time", "time", "date", "duration", "email", "hostname", "uri", "ipv4", "ipv6", "uuid"]);

/** Constraint keywords Anthropic refuses: carried in the description instead. */
const ANTHROPIC_DESCRIBED = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minProperties",
  "maxProperties",
  "maxItems",
  "uniqueItems",
  "contains",
  "minContains",
  "maxContains",
  "not",
  "if",
  "then",
  "else",
  "dependentRequired",
  "dependentSchemas",
  "dependencies",
  "unevaluatedProperties",
  "unevaluatedItems",
]);

/** How to turn the model's answer back into what the caller's schema describes. */
export type SchemaDecodePlan =
  | { kind: "json" }
  | { kind: "object"; props: Record<string, SchemaDecodePlan> }
  | { kind: "array"; items: SchemaDecodePlan }
  | { kind: "wrapped"; inner: SchemaDecodePlan | null };

interface Translated {
  schema: Node;
  plan: SchemaDecodePlan | null;
}

const ENCODED_NOTE = "Write this value as a JSON-encoded string (the JSON text of the value), matching this JSON Schema: ";

function encoded(original: unknown): Translated {
  const node = isNode(original) ? original : {};
  const { description, title, ...rest } = node;
  const shape = original === true || (isNode(original) && Object.keys(rest).length === 0) ? "{} (any JSON value)" : JSON.stringify(isNode(original) ? rest : original);
  const text = [typeof description === "string" ? description : null, ENCODED_NOTE + shape].filter(Boolean).join("\n\n");
  return {
    schema: { type: "string", ...(typeof title === "string" ? { title } : {}), description: text },
    plan: { kind: "json" },
  };
}

function typeList(node: Node): string[] {
  if (typeof node.type === "string") return [node.type];
  if (Array.isArray(node.type)) return node.type.filter((t): t is string => typeof t === "string");
  return [];
}

function translateAnthropic(value: unknown, root: Node, refStack: string[]): Translated {
  if (!isNode(value)) return encoded(value);
  let node: Node = value;

  if (typeof node.$ref === "string") {
    const ref = node.$ref;
    const target = resolveLocalRef(ref, root);
    if (target === undefined || refStack.includes(ref)) return encoded(node);
    const { $ref: _ref, ...siblings } = node;
    const merged: Node = isNode(target) ? { ...target, ...siblings } : siblings;
    return translateAnthropic(merged, root, [...refStack, ref]);
  }

  const out: Node = {};
  const described: string[] = [];
  let plan: SchemaDecodePlan | null = null;

  const branchesKey = Array.isArray(node.anyOf) ? "anyOf" : Array.isArray(node.oneOf) ? "oneOf" : null;
  if (branchesKey) {
    const branches = (node[branchesKey] as unknown[]).map((b) => translateAnthropic(b, root, refStack));
    if (branches.some((b) => b.plan !== null)) return encoded(node);
    out.anyOf = branches.map((b) => b.schema);
  }
  if (Array.isArray(node.allOf)) {
    const parts = (node.allOf as unknown[]).map((b) => translateAnthropic(b, root, refStack));
    if (parts.some((b) => b.plan !== null)) return encoded(node);
    out.allOf = parts.map((b) => b.schema);
  }

  const types = typeList(node);
  const constrained = types.length > 0 || "enum" in node || "const" in node || out.anyOf !== undefined || out.allOf !== undefined;
  if (!constrained) return encoded(node);

  if (types.includes("object")) {
    const addl = node.additionalProperties;
    const props = isNode(node.properties) ? node.properties : null;
    const freeForm = addl === true || isNode(addl) || node.patternProperties !== undefined || node.propertyNames !== undefined || (props === null && addl !== false);
    if (freeForm) return encoded(node);
  }
  if (types.includes("array")) {
    if (node.prefixItems !== undefined || !isNode(node.items)) return encoded(node);
  }

  for (const [key, val] of Object.entries(node)) {
    if (key === "anyOf" || key === "oneOf" || key === "allOf" || key === "$defs" || key === "definitions" || key === "additionalProperties") continue;
    if (key === "properties" && isNode(val)) {
      const props: Node = {};
      const childPlans: Record<string, SchemaDecodePlan> = {};
      for (const [name, sub] of Object.entries(val)) {
        const t = translateAnthropic(sub, root, refStack);
        props[name] = t.schema;
        if (t.plan) childPlans[name] = t.plan;
      }
      out.properties = props;
      if (Object.keys(childPlans).length > 0) plan = { kind: "object", props: childPlans };
    } else if (key === "items") {
      const t = translateAnthropic(val, root, refStack);
      out.items = t.schema;
      if (t.plan) plan = { kind: "array", items: t.plan };
    } else if (key === "minItems" && typeof val === "number" && val > 1) {
      described.push(`${key}: ${JSON.stringify(val)}`);
    } else if (key === "format" && typeof val === "string" && !ANTHROPIC_FORMATS.has(val)) {
      described.push(`${key}: ${JSON.stringify(val)}`);
    } else if (ANTHROPIC_DESCRIBED.has(key)) {
      described.push(`${key}: ${JSON.stringify(val)}`);
    } else {
      out[key] = val;
    }
  }
  if (types.includes("object")) out.additionalProperties = false;
  if (described.length > 0) {
    const existing = typeof out.description === "string" ? `${out.description}\n\n` : "";
    out.description = `${existing}{${described.join(", ")}}`;
  }
  return { schema: out, plan };
}

export interface AnthropicSchema {
  schema: Record<string, unknown>;
  /** Null when the answer needs no decoding (the common case). */
  plan: SchemaDecodePlan | null;
}

/** The caller's schema in Anthropic's strict dialect, plus how to decode the answer back. */
export function toAnthropicJsonSchema(schema: Record<string, unknown>): AnthropicSchema {
  const portable = toPortableJsonSchema(schema);
  const { $schema, $id, ...body } = portable;
  const t = translateAnthropic(body, portable, []);
  const header: Node = {
    ...(typeof $schema === "string" ? { $schema } : {}),
    ...(typeof $id === "string" ? { $id } : {}),
  };
  if (typeList(t.schema).includes("object") && t.schema.anyOf === undefined) {
    return { schema: { ...header, ...t.schema }, plan: t.plan };
  }
  // The root must be an object: anything else rides under one `value` key, unwrapped by `decode`.
  return {
    schema: { ...header, type: "object", properties: { value: t.schema }, required: ["value"], additionalProperties: false },
    plan: { kind: "wrapped", inner: t.plan },
  };
}

function decodeValue(value: Json, plan: SchemaDecodePlan | null): Json {
  if (plan === null) return value;
  switch (plan.kind) {
    case "json":
      if (typeof value !== "string") return value;
      try {
        return JSON.parse(value);
      } catch {
        // Served as written: the conformance measure names it against the caller's schema.
        console.warn(`[vendor-schema] a JSON-encoded field did not parse; served as the model wrote it`);
        return value;
      }
    case "object": {
      if (!isNode(value)) return value;
      const out: Node = { ...value };
      for (const [name, sub] of Object.entries(plan.props)) if (name in out) out[name] = decodeValue(out[name], sub);
      return out;
    }
    case "array":
      return Array.isArray(value) ? value.map((v) => decodeValue(v, plan.items)) : value;
    case "wrapped":
      return isNode(value) && "value" in value ? decodeValue(value.value, plan.inner) : value;
  }
}

/** Turns an answer to the translated schema back into the value the caller's schema describes. */
export function decodeSchemaAnswer(value: Json, plan: SchemaDecodePlan | null): Json {
  return decodeValue(value, plan);
}

/**
 * Same, on the answer TEXT: parsed, decoded, re-serialized. Text that is not JSON is returned untouched
 * (the route's strict parse then fails it loud, as before).
 */
export function decodeSchemaAnswerText(content: string, plan: SchemaDecodePlan | null): string {
  if (plan === null) return content;
  let parsed: Json;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content;
  }
  return JSON.stringify(decodeValue(parsed, plan));
}
