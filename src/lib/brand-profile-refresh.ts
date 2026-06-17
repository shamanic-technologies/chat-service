import { extractBrandFields, type ExtractFieldDef } from "./brand-client.js";
import {
  getBrandProfile,
  saveBrandProfileVersion,
  type BrandContentCallParams,
  type BrandProfileFieldValue,
  type BrandProfileFields,
  type BrandProfileVersion,
} from "./brand-content-client.js";

export interface BrandProfileFieldDefinition {
  key: string;
  description: string;
  type?: string;
}

export interface BrandProfileChangedField {
  field: string;
  before: BrandProfileFieldValue | null;
  after: BrandProfileFieldValue;
}

export interface BrandProfileWebsiteRefreshResult {
  saved: true;
  version: BrandProfileVersion;
  extractedFields: BrandProfileFields;
  changedFields: BrandProfileChangedField[];
  sourceUrlsByField: Record<string, string[]>;
}

export class BrandProfileRefreshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrandProfileRefreshError";
  }
}

const UPDATE_RE =
  /\b(update|refresh|sync|revise|regenerate|replace|save|mettre|mets|met|actualise|actualiser|rafraichis|rafraichir|maj|màj)\b/i;
const WEBSITE_RE =
  /\b(website|web\s*site|homepage|site\s*web|site\s*internet|dernier\s*site|site\s*actuel|current\s*site|latest\s*site)\b/i;
const READ_ONLY_OPINION_RE =
  /\b(should\s+i|dois-je|devrais-je|est\s*ce\s*que\s*je\s*(dois|devrais)|what\s*do\s*you\s*think|que\s*penses|penses-tu|avis|opinion)\b/i;

function normalizeIntentText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

export function isBrandProfileWebsiteRefreshIntent(message: string): boolean {
  const text = normalizeIntentText(message);
  return UPDATE_RE.test(text) && WEBSITE_RE.test(text) && !READ_ONLY_OPINION_RE.test(text);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function fieldKeyFromDefinition(definition: Record<string, unknown>): string | undefined {
  return firstString(
    definition.key,
    definition.field,
    definition.name,
    definition.id,
    definition.slug,
  );
}

function fieldDescriptionFromDefinition(
  key: string,
  definition: Record<string, unknown>,
): string {
  return firstString(
    definition.description,
    definition.extractDescription,
    definition.extractionDescription,
    definition.prompt,
    definition.label,
    definition.title,
  ) ?? `Brand profile field "${key}" from the brand's current website.`;
}

function definitionType(definition: Record<string, unknown>): string | undefined {
  return firstString(definition.type, definition.kind, definition.inputType);
}

function addDefinition(
  definitions: Map<string, BrandProfileFieldDefinition>,
  key: string | undefined,
  description: string | undefined,
  type?: string,
): void {
  if (!key || definitions.has(key)) return;
  definitions.set(key, {
    key,
    description: description ?? `Brand profile field "${key}" from the brand's current website.`,
    ...(type ? { type } : {}),
  });
}

function collectDefinitionsFromUnknown(
  value: unknown,
  definitions: Map<string, BrandProfileFieldDefinition>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isPlainObject(item)) continue;
      const key = fieldKeyFromDefinition(item);
      addDefinition(
        definitions,
        key,
        key ? fieldDescriptionFromDefinition(key, item) : undefined,
        definitionType(item),
      );
    }
    return;
  }

  if (!isPlainObject(value)) return;
  for (const [key, rawDefinition] of Object.entries(value)) {
    if (isPlainObject(rawDefinition)) {
      addDefinition(
        definitions,
        key,
        fieldDescriptionFromDefinition(key, rawDefinition),
        definitionType(rawDefinition),
      );
    } else if (typeof rawDefinition === "string") {
      addDefinition(definitions, key, rawDefinition);
    }
  }
}

function extractFieldsMap(value: unknown): BrandProfileFields | null {
  if (!isPlainObject(value)) return null;
  if (isPlainObject(value.fields)) return value.fields as BrandProfileFields;
  return value as BrandProfileFields;
}

function collectFallbackKeys(
  fields: BrandProfileFields | null | undefined,
  definitions: Map<string, BrandProfileFieldDefinition>,
): void {
  if (!fields) return;
  for (const [key, value] of Object.entries(fields)) {
    addDefinition(
      definitions,
      key,
      `Brand profile field "${key}" from the brand's current website.`,
      Array.isArray(value) ? "list" : undefined,
    );
  }
}

export function buildBrandProfileExtractionFields(
  context: Record<string, unknown> | undefined,
  currentFields: BrandProfileFields,
  overrideDefinitions?: unknown,
): BrandProfileFieldDefinition[] {
  const definitions = new Map<string, BrandProfileFieldDefinition>();

  collectDefinitionsFromUnknown(overrideDefinitions, definitions);
  collectDefinitionsFromUnknown(context?.fieldDefinitions, definitions);
  collectDefinitionsFromUnknown(context?.brandProfileFieldDefinitions, definitions);

  collectFallbackKeys(currentFields, definitions);
  collectFallbackKeys(extractFieldsMap(context?.currentBrandProfile), definitions);
  collectFallbackKeys(extractFieldsMap(context?.savedBrandProfile), definitions);

  return [...definitions.values()];
}

function wantsListField(
  field: string,
  currentFields: BrandProfileFields,
  definitions: BrandProfileFieldDefinition[],
): boolean {
  if (Array.isArray(currentFields[field])) return true;
  const definition = definitions.find((item) => item.key === field);
  const type = definition?.type?.toLowerCase();
  return type === "list" || type === "array" || type === "multi-select" || type === "multiselect";
}

function normalizeExtractedValue(
  value: unknown,
  wantsList: boolean,
): BrandProfileFieldValue | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    return wantsList ? [trimmed] : trimmed;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    const stringValue = String(value);
    return wantsList ? [stringValue] : stringValue;
  }

  if (Array.isArray(value)) {
    const values = value
      .map((item) => (typeof item === "string" ? item.trim() : undefined))
      .filter((item): item is string => Boolean(item));
    return values.length > 0 ? values : undefined;
  }

  return undefined;
}

function valuesEqual(a: BrandProfileFieldValue | undefined, b: BrandProfileFieldValue): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b);
}

function sourceUrlsForEntry(entry: { byBrand?: Record<string, { sourceUrls?: string[] | null }> }): string[] {
  const urls = new Set<string>();
  for (const byBrand of Object.values(entry.byBrand ?? {})) {
    for (const url of byBrand.sourceUrls ?? []) {
      if (url) urls.add(url);
    }
  }
  return [...urls];
}

export async function refreshBrandProfileFromWebsite(
  brandId: string,
  context: Record<string, unknown> | undefined,
  params: BrandContentCallParams,
  overrideDefinitions?: unknown,
): Promise<BrandProfileWebsiteRefreshResult> {
  const profile = await getBrandProfile(brandId, params);
  const currentFields = profile.current?.fields ?? {};
  const fieldDefinitions = buildBrandProfileExtractionFields(
    context,
    currentFields,
    overrideDefinitions,
  );

  if (fieldDefinitions.length === 0) {
    throw new BrandProfileRefreshError(
      "No brand profile field definitions were available, so I could not decide which website fields to extract.",
    );
  }

  const extractionFields: ExtractFieldDef[] = fieldDefinitions.map((field) => ({
    key: field.key,
    description: field.description,
  }));
  const extracted = await extractBrandFields(
    extractionFields,
    [brandId],
    params,
    { resetCache: true },
  );

  const extractedFields: BrandProfileFields = {};
  const sourceUrlsByField: Record<string, string[]> = {};

  for (const [field, entry] of Object.entries(extracted.fields)) {
    const normalized = normalizeExtractedValue(
      entry.value,
      wantsListField(field, currentFields, fieldDefinitions),
    );
    if (normalized === undefined) continue;
    extractedFields[field] = normalized;
    const sourceUrls = sourceUrlsForEntry(entry);
    if (sourceUrls.length > 0) sourceUrlsByField[field] = sourceUrls;
  }

  if (Object.keys(extractedFields).length === 0) {
    throw new BrandProfileRefreshError(
      "Website extraction completed but returned no usable brand profile values to save.",
    );
  }

  const mergedFields: BrandProfileFields = { ...currentFields, ...extractedFields };
  const changedFields = Object.entries(extractedFields)
    .filter(([field, value]) => !valuesEqual(currentFields[field], value))
    .map(([field, after]) => ({
      field,
      before: currentFields[field] ?? null,
      after,
    }));

  const saved = await saveBrandProfileVersion(brandId, mergedFields, params);
  return {
    saved: true,
    version: saved.version,
    extractedFields,
    changedFields,
    sourceUrlsByField,
  };
}

export function formatBrandProfileWebsiteRefreshMessage(
  result: BrandProfileWebsiteRefreshResult,
): string {
  const changed = result.changedFields.map((field) => field.field);
  const summary = changed.length > 0
    ? `Updated fields: ${changed.slice(0, 8).join(", ")}${changed.length > 8 ? ", ..." : ""}.`
    : "No field values changed after the fresh extraction.";
  return `Saved brand profile v${result.version.version} from the latest website extraction. ${summary}`;
}

export function formatBrandProfileWebsiteRefreshErrorMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `I couldn't refresh the brand profile from the website: ${detail}`;
}
