import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildBrandProfileExtractionFields,
  formatBrandProfileWebsiteRefreshMessage,
  isBrandProfileWebsiteRefreshIntent,
  refreshBrandProfileFromWebsite,
} from "../../src/lib/brand-profile-refresh.js";

vi.mock("../../src/lib/brand-content-client.js", () => ({
  getBrandProfile: vi.fn(),
  saveBrandProfileVersion: vi.fn(),
}));

vi.mock("../../src/lib/brand-client.js", () => ({
  extractBrandFields: vi.fn(),
}));

const brandContent = await import("../../src/lib/brand-content-client.js");
const brandClient = await import("../../src/lib/brand-client.js");

const baseParams = {
  orgId: "org-1",
  userId: "user-1",
  runId: "run-1",
};

describe("isBrandProfileWebsiteRefreshIntent", () => {
  it("detects French latest-website update requests", () => {
    expect(isBrandProfileWebsiteRefreshIntent("Mets a jour avec mon dernier site web")).toBe(true);
    expect(isBrandProfileWebsiteRefreshIntent("Mets à jour avec mon dernier site web")).toBe(true);
  });

  it("does not classify read-only opinion requests as saves", () => {
    expect(isBrandProfileWebsiteRefreshIntent("Que penses-tu de mon dernier site web ?")).toBe(false);
    expect(isBrandProfileWebsiteRefreshIntent("Dois-je mettre à jour avec mon dernier site web ?")).toBe(false);
  });
});

describe("buildBrandProfileExtractionFields", () => {
  it("prefers context fieldDefinitions and falls back to current profile keys", () => {
    expect(
      buildBrandProfileExtractionFields(
        {
          fieldDefinitions: [
            { key: "valueProposition", label: "Value proposition", type: "text" },
          ],
        },
        { differentiators: ["old"] },
      ),
    ).toEqual([
      {
        key: "valueProposition",
        description: "Value proposition",
        type: "text",
      },
      {
        key: "differentiators",
        description: 'Brand profile field "differentiators" from the brand\'s current website.',
        type: "list",
      },
    ]);
  });
});

describe("refreshBrandProfileFromWebsite", () => {
  beforeEach(() => {
    vi.mocked(brandContent.getBrandProfile).mockReset();
    vi.mocked(brandContent.saveBrandProfileVersion).mockReset();
    vi.mocked(brandClient.extractBrandFields).mockReset();
  });

  it("gets current profile, extracts fresh website values, and saves a new full version", async () => {
    vi.mocked(brandContent.getBrandProfile).mockResolvedValue({
      current: {
        id: "v2",
        brandId: "brand-1",
        version: 2,
        fields: {
          valueProposition: "Old value",
          differentiators: ["Old differentiator"],
          tone: "Direct",
        },
        createdAt: "2026-06-01T00:00:00Z",
      },
      versions: [{ id: "v2", version: 2, createdAt: "2026-06-01T00:00:00Z" }],
    });
    vi.mocked(brandClient.extractBrandFields).mockResolvedValue({
      brands: [],
      fields: {
        valueProposition: {
          value: "New website value",
          byBrand: {
            "example.com": {
              value: "New website value",
              cached: false,
              extractedAt: "2026-06-17T00:00:00Z",
              expiresAt: null,
              sourceUrls: ["https://example.com"],
            },
          },
        },
        differentiators: {
          value: ["Fast setup", "Clean reporting"],
          byBrand: {},
        },
      },
    });
    vi.mocked(brandContent.saveBrandProfileVersion).mockResolvedValue({
      version: {
        id: "v3",
        brandId: "brand-1",
        version: 3,
        fields: {},
        createdAt: "2026-06-17T00:00:00Z",
      },
    });

    const result = await refreshBrandProfileFromWebsite(
      "brand-1",
      {
        fieldDefinitions: [
          { key: "valueProposition", description: "The brand value proposition" },
          { key: "differentiators", description: "List of differentiators", type: "list" },
        ],
      },
      baseParams,
    );

    expect(brandContent.getBrandProfile).toHaveBeenCalledWith("brand-1", baseParams);
    expect(brandClient.extractBrandFields).toHaveBeenCalledWith(
      [
        { key: "valueProposition", description: "The brand value proposition" },
        { key: "differentiators", description: "List of differentiators" },
        { key: "tone", description: 'Brand profile field "tone" from the brand\'s current website.' },
      ],
      ["brand-1"],
      baseParams,
      { resetCache: true },
    );
    expect(brandContent.saveBrandProfileVersion).toHaveBeenCalledWith(
      "brand-1",
      {
        valueProposition: "New website value",
        differentiators: ["Fast setup", "Clean reporting"],
        tone: "Direct",
      },
      baseParams,
    );
    expect(result.version.version).toBe(3);
    expect(result.changedFields.map((field) => field.field)).toEqual([
      "valueProposition",
      "differentiators",
    ]);
    expect(formatBrandProfileWebsiteRefreshMessage(result)).toContain("Saved brand profile v3");
  });
});
