import { describe, expect, it } from "vitest";
import { expectedReturnWords, realizedReturnWords, returnLine } from "../../src/lib/return-words.js";

describe("the only two returns a client is told (ROI-CONSISTENCY-1103)", () => {
  it("brand Beyond Logic: expected and realized, never the pipeline ROI", () => {
    expect(returnLine({ roiMultiple: 18.2 }, { closedWonCount: 0, closedWonRevenueUsd: 0, roiMultiple: 0, spentUsd: 94.1 })).toBe(
      "Expected 18x · no paid client yet ($94 spent)",
    );
  });

  it("expected says why when there is none", () => {
    expect(expectedReturnWords({ roiMultiple: null, unavailableReason: "no_priced_sales_path" })).toBe("Expected return not known (no path we can price yet)");
    expect(expectedReturnWords({ roiMultiple: 2.44 })).toBe("Expected 2.4x");
    expect(expectedReturnWords(null)).toBeNull();
  });

  it("realized names the paid clients, their worth and the money spent", () => {
    expect(realizedReturnWords({ closedWonCount: 1, closedWonRevenueUsd: 4000, roiMultiple: 12.4, spentUsd: 322.5 })).toBe(
      "Realized 12x: 1 paid client worth $4,000 for $323 spent",
    );
    expect(realizedReturnWords({ closedWonCount: 1, closedWonRevenueUsd: 4000, roiMultiple: null, spentUsd: 0 })).toBe("1 paid client worth $4,000, nothing spent yet");
  });

  it("a realized block without spentUsd is the retired mature-cohort basis: not stated", () => {
    expect(realizedReturnWords({ closedWonCount: 0, closedWonRevenueUsd: 0, roiMultiple: 0 })).toBeNull();
    expect(returnLine(undefined, null)).toBe("no return served yet");
  });
});
