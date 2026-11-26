import { describe, it, expect } from "vitest";
import {
  CLIENT_BRIEF_FIELDS,
  clientBriefUnavailable,
  formatClientBrief,
  readClientBrief,
  readSiteFields,
} from "../../src/lib/client-brief.js";

// SOPHIE-JCURVE-1102, prod 2026-11-01: a returning signup (a NetSuite partner)
// opened the Copilot and was asked what his company sells while its website was
// on file. The turn now starts with what we read from that website.
const JCURVE = {
  id: "6875c68e-eaae-4e24-8e24-29d1e78d3eff",
  name: "Jcurve",
  domain: "jcurvesolutions.com",
  brandUrl: "https://www.jcurvesolutions.com/jcurve-erp/",
};
const OFFERS = { offers: [{ name: "Default Offer", status: "active", description: null }, { name: "Old", status: "archived", description: "x" }] };
const SITE = {
  fields: {
    whatTheySell: { value: "Jcurve ERP, a NetSuite edition for growing companies, with implementation and support." },
    whoBuys: { value: ["Small and mid-sized companies in Australia", "finance leaders outgrowing accounting software"] },
  },
};

describe("client brief: what the Copilot knows before the client says a word", () => {
  it("states what the company sells and who buys it, read from its website, and the next step to propose", async () => {
    const read: string[] = [];
    const brands = await readClientBrief({
      listBrands: async () => ({ brands: [JCURVE] }),
      listOffers: async () => OFFERS,
      readWebsite: async (id) => {
        read.push(id);
        return readSiteFields(SITE);
      },
    });
    expect(read).toEqual([JCURVE.id]);
    const text = formatClientBrief(brands);
    expect(text).toContain("### Jcurve (https://www.jcurvesolutions.com/jcurve-erp/)");
    expect(text).toContain("What they sell: Jcurve ERP, a NetSuite edition");
    expect(text).toContain("Who buys from them: Small and mid-sized companies in Australia; finance leaders");
    expect(text).toContain("propose the next concrete step");
    // The archived offer is not the client's offer today; a missing description is ours to write.
    expect(text).not.toContain('Offer "Old"');
    expect(text).toContain('Offer "Default Offer": no description yet; describe it from what they sell');
  });

  it("a website that cannot be read is SAID (never dropped), and the agent reads it itself", async () => {
    const brands = await readClientBrief({
      listBrands: async () => ({ brands: [JCURVE] }),
      listOffers: async () => OFFERS,
      readWebsite: async () => {
        throw new Error("brand-service 502");
      },
    });
    expect(formatClientBrief(brands)).toContain("Their website could not be read for this turn (brand-service 502): read it once with your tools");
    // Still unreadable: the address is said not to open, and checked with them (DISTRY-GUEST-CAPS-1119, dutrou.com).
    expect(formatClientBrief(brands)).toContain("tell them plainly that the address does not open and ask whether it is the right one");
  });

  it("a slow first read times out into the same sentence; the turn does not wait forever", async () => {
    const brands = await readClientBrief(
      {
        listBrands: async () => ({ brands: [JCURVE] }),
        listOffers: async () => OFFERS,
        readWebsite: () => new Promise(() => {}),
      },
      20,
    );
    expect(formatClientBrief(brands)).toContain("could not be read for this turn (still reading after 0s)");
  });

  it("a failed brand list throws (the caller states it), and an account with no brand is told to set one up", async () => {
    await expect(
      readClientBrief({
        listBrands: async () => {
          throw new Error("api 500");
        },
        listOffers: async () => OFFERS,
        readWebsite: async () => readSiteFields(SITE),
      }),
    ).rejects.toThrow("api 500");
    expect(clientBriefUnavailable(new Error("api 500"))).toContain("Their account could not be read for this turn (api 500)");
    expect(formatClientBrief([])).toContain("They have no brand yet");
  });

  it("asks brand-service for two stable fields (their descriptions key its 30-day cache)", () => {
    expect(CLIENT_BRIEF_FIELDS.map((f) => f.key)).toEqual(["whatTheySell", "whoBuys"]);
    expect(readSiteFields({})).toEqual({ whatTheySell: null, whoBuys: null });
  });
});

// COPILOT-LATENCY-1125 (prod 2026-11-25): the org's other brand was read under the turn run
// carrying the page's brand; runs-service 409'd brand-service's /complete three times a turn.
describe("which run a brand's website is read under", () => {
  it("the turn run only when it carries no brand or exactly this one", async () => {
    const { briefReadsOnTurnRun, brandIdsOfHeader } = await import("../../src/lib/brief-run.js");
    const page = "f4d73dab-1f9d-49b2-b16e-63ecde76a5eb";
    const other = "47823ca5-0000-4000-8000-000000000000";
    expect(brandIdsOfHeader(undefined)).toEqual([]);
    expect(brandIdsOfHeader(` ${page}, ${other} `)).toEqual([page, other]);
    expect(briefReadsOnTurnRun([], other)).toBe(true);
    expect(briefReadsOnTurnRun([page], page)).toBe(true);
    expect(briefReadsOnTurnRun([page], other)).toBe(false);
    expect(briefReadsOnTurnRun([page, other], page)).toBe(false);
  });
});

