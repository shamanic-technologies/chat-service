/**
 * The brand a brand-scoped tool acts on (COPILOT-WA-BRAND-1027).
 *
 * A web turn opened on a brand page carries it in context.brandId (or the
 * x-brand-id header): that brand wins, exactly as before, and a `brandId`
 * argument from the model is ignored. A turn with NO brand in context (every
 * WhatsApp turn, a web turn with no page context) resolves it from the org:
 *   - one brand  -> that brand;
 *   - several    -> the `brandId` the model passed, checked against the org's
 *                   own brands; none passed -> BrandChoiceRequired, whose
 *                   result lists the brands so the model asks the person;
 *   - none       -> a plain error saying the account has no brand yet.
 * Never a silent guess among several brands. One shared path for every
 * brand-scoped tool: never a per-tool or per-channel branch.
 */
import type Anthropic from "@anthropic-ai/sdk";

export interface OrgBrand {
  id: string;
  name: string | null;
  domain: string | null;
}

/** The tools that act on ONE brand. Each gets an optional `brandId` argument. */
export const BRAND_SCOPED_TOOL_NAMES: readonly string[] = [
  "list_personas",
  "create_persona",
  "duplicate_persona",
  "set_persona_status",
  "get_brand_profile",
  "save_brand_profile_version",
  "refresh_brand_profile_from_website",
  "list_audiences",
  "suggest_audiences",
  "list_qualification_checks",
  "list_qualification_sources",
  "suggest_qualification_checks",
  "create_qualification_check",
  "update_qualification_check",
  "archive_qualification_check",
];

export const BRAND_ID_ARG_DESCRIPTION =
  "Optional. Only when the chat has no brand open (WhatsApp, or no brand page) AND the account has several brands: the id of the brand to act on, from list_brands, after the person said which one. Ignored when a brand is open; not needed when the account has one brand.";

/** Adds the optional `brandId` argument to a brand-scoped tool (copy, never mutates the registry). */
export function withBrandIdArg(tool: Anthropic.Tool): Anthropic.Tool {
  if (!BRAND_SCOPED_TOOL_NAMES.includes(tool.name)) return tool;
  const schema = tool.input_schema as { properties?: Record<string, unknown> };
  if (schema.properties && "brandId" in schema.properties) return tool;
  return {
    ...tool,
    input_schema: {
      ...tool.input_schema,
      properties: {
        ...(schema.properties ?? {}),
        brandId: { type: "string", description: BRAND_ID_ARG_DESCRIPTION },
      },
    },
  };
}

/** The account has several brands and the model named none: a result the model reads, never an error. */
export class BrandChoiceRequired extends Error {
  constructor(
    readonly toolName: string,
    readonly brands: OrgBrand[],
  ) {
    super(`${toolName}: several brands, none chosen`);
    this.name = "BrandChoiceRequired";
  }

  toResult(): Record<string, unknown> {
    return {
      brandChoiceRequired: true,
      brands: this.brands,
      instruction:
        `This account has ${this.brands.length} brands and none is open in this chat. Ask the person which brand they mean (by name), then call ${this.toolName} again with that brand's id as brandId. Never pick one yourself.`,
    };
  }
}

/** Reads the org's brands from the list_brands body (GET /v1/brands), either `{brands: [...]}` or a bare array. */
export function toOrgBrands(body: unknown): OrgBrand[] {
  const rows = Array.isArray(body)
    ? body
    : body && typeof body === "object" && Array.isArray((body as { brands?: unknown }).brands)
      ? (body as { brands: unknown[] }).brands
      : null;
  if (!rows) throw new Error("[chat] list_brands answered without a brands list");
  return rows.flatMap((row) => {
    const r = row as Record<string, unknown>;
    if (typeof r.id !== "string") return [];
    const name = typeof r.name === "string" ? r.name : null;
    const domain = typeof r.domain === "string" ? r.domain : typeof r.url === "string" ? r.url : null;
    return [{ id: r.id, name, domain }];
  });
}

export interface TurnBrandResolver {
  /** The ONE brand this tool call acts on. Throws BrandChoiceRequired when the model must ask. */
  require(toolName: string, args?: Record<string, unknown>): Promise<string>;
}

export function createTurnBrandResolver(deps: {
  /** Brands the turn carries (header CSV or context.brandId); empty when none. */
  contextBrandIds: string[];
  /** The org's brands, read once per turn on first need. */
  listOrgBrands: () => Promise<OrgBrand[]>;
}): TurnBrandResolver {
  let orgBrands: Promise<OrgBrand[]> | null = null;
  const brandsOfOrg = () => (orgBrands ??= deps.listOrgBrands());

  return {
    async require(toolName, args) {
      const { contextBrandIds } = deps;
      if (contextBrandIds.length > 1) {
        throw new Error(
          `[chat] ${toolName} operates on a single brand, but ${contextBrandIds.length} were provided`,
        );
      }
      if (contextBrandIds.length === 1) return contextBrandIds[0];

      const brands = await brandsOfOrg();
      const asked = typeof args?.brandId === "string" && args.brandId.trim() ? args.brandId.trim() : null;
      if (asked) {
        if (brands.some((b) => b.id === asked)) return asked;
        throw new Error(
          `brandId "${asked}" is not one of this account's brands. Call list_brands and use one of their ids.`,
        );
      }
      if (brands.length === 1) return brands[0].id;
      if (brands.length === 0) {
        throw new Error(
          "This account has no brand yet: create one from the person's website (create_brand_from_url) first.",
        );
      }
      throw new BrandChoiceRequired(toolName, brands);
    },
  };
}
