import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  engineToolsFrom,
  engineToolName,
  startEngineCampaign,
  readEngineCampaign,
  listEngines,
  READ_ENGINE_CAMPAIGN_TOOL_NAME,
  type EngineListing,
  type WorkflowFetch,
  type CampaignFetch,
} from "../../src/agent/engine-tools.js";
import { isPrincipalToolName } from "../../src/agent/principal-tools.js";

const engines: EngineListing[] = [
  { outcome: "newsletter_drafted", name: "Newsletter drafted", callable: true, reason: null, inputs: [{ units: [], channel: null }] },
  { outcome: "message_written", name: "Message written", callable: true, reason: null, inputs: [{ units: ["lead_found"], channel: "email" }] },
  { outcome: "backlink_earned", name: "Backlink earned", callable: false, reason: "No script can run now.", inputs: [] },
];

const target = { orgId: "06ffd332-b05d-4468-bc33-fe2789caad95", userId: "user-1", brandId: "brand-1", runId: "run-1" };
const CAMPAIGN_ID = "11111111-1111-1111-1111-111111111111";

type Seen = { service: string; path: string; method: string; headers: Record<string, string>; body: unknown };

function producers(over: Partial<Record<string, (s: Seen) => Response>> = {}): { fetchImpl: CampaignFetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchImpl: CampaignFetch = async (service, path, init) => {
    const s: Seen = { service, path, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined };
    seen.push(s);
    const key = `${service} ${init.method}`;
    if (over[key]) return over[key]!(s);
    if (key === "campaign POST")
      return Response.json({ salesFunnelCampaign: { id: CAMPAIGN_ID, salesFunnelId: "newsletter_drafted", salesFunnelName: "Newsletter drafted", status: "stopped" }, created: true, firstRun: { waitingFor: "caps" } });
    if (key === "billing PUT") return Response.json({ maxVolume: { count: 1, period: "one_off" }, maxBudget: { amountCents: 100, period: "one_off" }, funded: true });
    if (key === "campaign PATCH")
      return Response.json({ salesFunnelCampaign: { id: CAMPAIGN_ID, status: "ongoing" }, firstRun: { at: "2026-11-21T12:05:00.000Z" } });
    if (key === "campaign GET") return Response.json({ unitsMade: 1, spendUsd: 0.04, finished: true, idleReason: null });
    throw new Error(`unexpected ${key} ${path}`);
  };
  return { fetchImpl, seen };
}

describe("Distry's Engine tools come from the live list (DISTRY-PRINCIPAL-1119)", () => {
  it("one tool per callable Engine, plus the campaign reader; none for an Engine that cannot run", () => {
    const { tools, outcomeOf } = engineToolsFrom(engines);
    expect(tools.map((t) => t.name)).toEqual(["engine__newsletter_drafted", "engine__message_written", READ_ENGINE_CAMPAIGN_TOOL_NAME]);
    expect(outcomeOf.get("engine__message_written")).toBe("message_written");
    expect(tools.every((t) => isPrincipalToolName(t.name))).toBe(true);
    const props = tools[0].input_schema.properties as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(["brandId", "brief", "maxBudget", "maxVolume", "offerId", "orgId"]);
    expect(tools[0].input_schema.required).toEqual(["brief"]);
    expect(tools[1].description).toContain("Units of lead_found (channel email)");
  });

  it("no callable Engine = no tool at all", () => {
    expect(engineToolsFrom([engines[2]]).tools).toEqual([]);
  });

  it("tool names are safe for every model API", () => {
    expect(engineToolName("LinkedIn post: published!")).toBe("engine__LinkedIn_post_published_");
    expect(engineToolName("x".repeat(100)).length).toBe(64);
  });

  it("listing fails loud on an unreadable answer", async () => {
    const broken: WorkflowFetch = async () => new Response("down", { status: 502 });
    await expect(listEngines(broken)).rejects.toThrow(/engine list 502/);
  });
});

describe("an Engine call is ALWAYS a campaign (DISTRY-CALL-IS-CAMPAIGN-1121)", () => {
  it("create stopped on the outcome → caps at billing on that campaign → activate; answers the first run at once", async () => {
    const { fetchImpl, seen } = producers();
    const out = await startEngineCampaign(
      "newsletter_drafted",
      { brief: "One newsletter draft about our November results", maxBudget: { usd: 1, period: "one_off" }, maxVolume: { count: 1, period: "one_off" } },
      target,
      fetchImpl,
    );
    expect(seen.map((s) => `${s.service} ${s.method} ${s.path}`)).toEqual([
      "campaign POST /sales-funnel-campaigns",
      `billing PUT /v1/brands/brand-1/sales-funnels/newsletter_drafted/campaigns/${CAMPAIGN_ID}/caps`,
      `campaign PATCH /sales-funnel-campaigns/${CAMPAIGN_ID}`,
    ]);
    expect(seen[0].body).toEqual({ brandId: "brand-1", target: "newsletter_drafted", brief: "One newsletter draft about our November results", status: "stopped" });
    expect(seen[0].headers).toMatchObject({ "x-org-id": target.orgId, "x-user-id": "user-1", "x-run-id": "run-1", "x-brand-id": "brand-1" });
    expect(seen[1].body).toEqual({ maxVolume: { count: 1, period: "one_off" }, maxBudget: { amountCents: 100, period: "one_off" } });
    expect(seen[2].body).toEqual({ status: "activate" });
    expect(out).toMatchObject({ campaignId: CAMPAIGN_ID, status: "ongoing", created: true, firstRun: { at: "2026-11-21T12:05:00.000Z" }, caps: { funded: true } });
  });

  it("a stated offer rides the campaign and its caps path", async () => {
    const { fetchImpl, seen } = producers();
    await startEngineCampaign("newsletter_drafted", { brief: "b", offerId: "offer-9", maxVolume: { count: 3, period: "weekly" } }, target, fetchImpl);
    expect(seen[0].body).toMatchObject({ offerId: "offer-9" });
    expect(seen[1].path).toBe(`/v1/brands/brand-1/offers/offer-9/sales-funnels/newsletter_drafted/campaigns/${CAMPAIGN_ID}/caps`);
    expect(seen[1].body).toEqual({ maxVolume: { count: 3, period: "weekly" }, maxBudget: null });
  });

  it("refuses before any call: no brief, no cap, a bad period", async () => {
    const { fetchImpl, seen } = producers();
    await expect(startEngineCampaign("x", { maxVolume: { count: 1, period: "one_off" } }, target, fetchImpl)).rejects.toThrow(/brief is required/);
    await expect(startEngineCampaign("x", { brief: "b" }, target, fetchImpl)).rejects.toThrow(/max volume, a max budget, or both/);
    await expect(startEngineCampaign("x", { brief: "b", maxBudget: { usd: 1, period: "hourly" } }, target, fetchImpl)).rejects.toThrow(/period must be one of/);
    await expect(startEngineCampaign("x", { brief: "b", maxVolume: { count: 0, period: "daily" } }, target, fetchImpl)).rejects.toThrow(/at least 1/);
    expect(seen).toEqual([]);
  });

  it("a producer's refusal (4xx) is answered in its own words; a 5xx fails loud", async () => {
    const refused = producers({ "campaign POST": () => Response.json({ error: "Nothing makes it yet.", reason: "engine_not_live" }, { status: 409 }) });
    expect(await startEngineCampaign("x", { brief: "b", maxVolume: { count: 1, period: "one_off" } }, target, refused.fetchImpl)).toMatchObject({
      status: "refused",
      by: "campaign-service",
      reason: "engine_not_live",
    });
    const down = producers({ "billing PUT": () => Response.json({ error: "boom" }, { status: 502 }) });
    await expect(startEngineCampaign("x", { brief: "b", maxVolume: { count: 1, period: "one_off" } }, target, down.fetchImpl)).rejects.toThrow(/billing-service campaign caps 502: boom/);
  });

  it("progress is read from campaign-service, by campaign id", async () => {
    const { fetchImpl, seen } = producers();
    expect(await readEngineCampaign(CAMPAIGN_ID, target, fetchImpl)).toMatchObject({ unitsMade: 1, finished: true });
    expect(seen[0].service).toBe("campaign");
    expect(seen[0].path.startsWith(`/sales-funnel-campaigns/${CAMPAIGN_ID}`)).toBe(true);
    await expect(readEngineCampaign("nope", target, fetchImpl)).rejects.toThrow(/not a campaign id/);
  });

  it("no code path calls workflow-service's former direct Engine call or call-status route", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk(join(process.cwd(), "src"));
    const hits = files.filter((f) => {
      const code = readFileSync(f, "utf8").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
      return /\/internal\/engines\/[^"'`\s]*\/calls|\/internal\/engine-calls/.test(code);
    });
    expect(hits).toEqual([]);
  });
});
