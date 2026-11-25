import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import {
  DISTRY_LIMIT_NOTICE_ACCOUNT,
  DISTRY_LIMIT_NOTICE_GUEST,
  distryGate,
  distrySpendDaysSeries,
  recordDistryTurn,
  refreshDistrySpendDay,
  soloPlanLimitNotice,
  type DistryPerson,
  type DistrySpendDeps,
  type SoloAiGate,
} from "../../src/lib/distry-spend.js";

const NOT_ON_PLAN: SoloAiGate = { on_solo_plan: false, may_use_our_keys: true, refused_reason: null, debt_cents: null, debt_limit_cents: null, upgrade_url: null };
const UPGRADE = "https://distribute.you/upgrade?org=staff-test";

// DISTRY-GUEST-CAPS-1119 on a real Postgres (CI's throwaway container, migrated
// from the journal): the caps read DOLLARS from the ledger (faked here, staff
// ids only: no real person or org), a paying client is never capped, and the
// day's alert leaves once per channel.

const connectionString = process.env.CHAT_SERVICE_DATABASE_URL;
const OURS = `org-ours-${Date.now()}`;
const tag = `dgs${Date.now()}`;

describe("Distry's spend on non-clients", { timeout: 30_000 }, () => {
  let client: ReturnType<typeof postgres>;
  let db: DistrySpendDeps["db"];
  // The fake ledger: cents per run tree (under our org) and per org total.
  let runCents: Map<string, number>;
  let orgCents: Map<string, number>;
  let paying: Set<string>;
  let now: Date;
  let env: NodeJS.ProcessEnv;
  // SOLO-PLAN-1125: billing's solo-plan verdict per org (absent = not on the plan) + local-Claude orgs.
  let solo: Map<string, SoloAiGate>;
  let localOrgs: Set<string>;

  const deps = (): DistrySpendDeps => ({
    db,
    ourOrgId: () => OURS,
    isPayingOrg: vi.fn(async (orgId: string) => paying.has(orgId)),
    soloAiGate: vi.fn(async (orgId: string) => solo.get(orgId) ?? NOT_ON_PLAN),
    isLocalLlmOrg: vi.fn(async (orgId: string) => localOrgs.has(orgId)),
    runTreeCents: vi.fn(async (orgId: string, runIds: string[]) => {
      expect(orgId).toBe(OURS);
      return runIds.reduce((s, id) => s + (runCents.get(id) ?? 0), 0);
    }),
    orgTotalCents: vi.fn(async (orgId: string) => orgCents.get(orgId) ?? 0),
    now: () => now,
    env,
  });

  const guest = (n: string, planOrgId: string | null = null): DistryPerson => ({ key: `web:${tag}-${n}`, surface: "web", guest: true, turnOrgId: OURS, planOrgId });
  const account = (orgId: string): DistryPerson => ({ key: `org:${orgId}`, surface: "telegram", guest: false, turnOrgId: orgId, planOrgId: null });

  beforeAll(() => {
    if (!connectionString) throw new Error("CHAT_SERVICE_DATABASE_URL is required");
    client = postgres(connectionString, { max: 4 });
    db = drizzle(client) as unknown as DistrySpendDeps["db"];
  });

  beforeEach(async () => {
    await client`DELETE FROM distry_spend_turns`;
    await client`DELETE FROM distry_spend_orgs`;
    await client`DELETE FROM distry_spend_days`;
    runCents = new Map();
    orgCents = new Map();
    paying = new Set();
    solo = new Map();
    localOrgs = new Set();
    now = new Date("2026-11-19T10:00:00Z");
    env = {};
  });

  afterAll(async () => {
    await client`DELETE FROM distry_spend_turns`;
    await client`DELETE FROM distry_spend_orgs`;
    await client`DELETE FROM distry_spend_days`;
    await client.end();
  });

  it("a visitor below $5 goes on; at $5 (guest turns + their plan org) they get the notice and no model runs", async () => {
    const d = deps();
    const plan = `plan-${tag}-a`;
    const v = await distryGate(d, guest("a", plan));
    expect(v).toMatchObject({ run: true, tracked: true });
    // The plan org was never seen: its whole spend counts, from 0.
    orgCents.set(plan, 200);
    await recordDistryTurn(d, v, "run-a1", plan);
    runCents.set("run-a1", 299);
    expect(await distryGate(d, guest("a", plan))).toMatchObject({ run: true });
    await recordDistryTurn(d, { run: true, tracked: true, person: guest("a", plan) }, "run-a2", plan);
    runCents.set("run-a2", 1); // 299 + 1 + 200 = $5.00
    const capped = await distryGate(d, guest("a", plan));
    expect(capped).toMatchObject({ run: false, reason: "person_cap", notice: DISTRY_LIMIT_NOTICE_GUEST });
    // Another visitor is not touched by the first one's limit.
    expect(await distryGate(d, guest("b"))).toMatchObject({ run: true });
    const rows = await client`SELECT verdict, person_key FROM distry_spend_turns WHERE verdict <> 'ran'`;
    expect(rows).toEqual([{ verdict: "person_cap", person_key: `web:${tag}-a` }]);
  });

  it("the $5 is DISTRY_VISITOR_USD and the day is DISTRY_NONPAYER_DEBT_GROWTH_USD: tunable, a bad value fails loud", async () => {
    env = { DISTRY_VISITOR_USD: "0.5" };
    const d = deps();
    const v = await distryGate(d, guest("c"));
    await recordDistryTurn(d, v, "run-c1", null);
    runCents.set("run-c1", 50);
    expect(await distryGate(d, guest("c"))).toMatchObject({ run: false, reason: "person_cap" });
    env = { DISTRY_NONPAYER_DEBT_GROWTH_USD: "lots" };
    await expect(distryGate(deps(), guest("d"))).rejects.toThrow(/DISTRY_NONPAYER_DEBT_GROWTH_USD must be a dollar amount/);
  });

  it("the day's limit stops every non-client (guest and account that never paid); a paying client and our staff never", async () => {
    await client`INSERT INTO distry_spend_days (day, spend_cents, threshold_cents, refreshed_at) VALUES ('2026-11-19', '2000', '2000', now())`;
    const d = deps();
    expect(await distryGate(d, guest("e"))).toMatchObject({ run: false, reason: "day_cap", notice: DISTRY_LIMIT_NOTICE_GUEST });
    expect(await distryGate(d, account("org-unpaid"))).toMatchObject({ run: false, reason: "day_cap", notice: DISTRY_LIMIT_NOTICE_ACCOUNT });
    paying.add("org-paid");
    expect(await distryGate(d, account("org-paid"))).toMatchObject({ run: true, tracked: false });
    // Our own org, signed in = staff.
    expect(await distryGate(d, { ...account(OURS), key: "web:staff" })).toMatchObject({ run: true, tracked: false });
    // Tomorrow is a new day.
    now = new Date("2026-11-20T00:00:01Z");
    expect(await distryGate(deps(), guest("e"))).toMatchObject({ run: true });
  });

  it("a paying client is never capped, whatever it spent and whatever the day says", async () => {
    paying.add("org-big");
    orgCents.set("org-big", 1_000_000);
    await client`INSERT INTO distry_spend_days (day, spend_cents, threshold_cents, refreshed_at) VALUES ('2026-11-19', '999999', '3000', now())`;
    const v = await distryGate(deps(), account("org-big"));
    expect(v).toMatchObject({ run: true, tracked: false });
    expect(await client`SELECT * FROM distry_spend_orgs`).toHaveLength(0);
  });

  it("SOLO-PLAN-1125: the non-payers' debt may grow $20 a day by default (owner), the $30 limit is gone", async () => {
    const g = await distryGate(deps(), guest("k"));
    await recordDistryTurn(deps(), g, "run-k1", null);
    runCents.set("run-k1", 1999);
    const d = { ...deps(), sendTelegram: vi.fn(async () => ({ ok: true as const })), sendEmail: vi.fn(async () => {}), sendWhatsapp: vi.fn(async () => {}) };
    expect(await refreshDistrySpendDay(d)).toMatchObject({ spendCents: 1999, thresholdCents: 2000, alerted: [] });
    expect(await distryGate(d, guest("l"))).toMatchObject({ run: true });
    runCents.set("run-k1", 2000);
    expect(await refreshDistrySpendDay(d)).toMatchObject({ spendCents: 2000, alerted: ["telegram", "whatsapp", "email"] });
    expect(await distryGate(d, guest("l"))).toMatchObject({ run: false, reason: "day_cap" });
    expect(await distryGate(d, account("org-never-paid"))).toMatchObject({ run: false, reason: "day_cap", notice: DISTRY_LIMIT_NOTICE_ACCOUNT });
  });

  it("the day measures guest run trees + each non-client org's spend SINCE first seen today; the alert leaves once per channel (Telegram, WhatsApp, email)", async () => {
    env = { DISTRY_NONPAYER_DEBT_GROWTH_USD: "30" };
    const telegram = vi.fn(async () => ({ ok: true as const }));
    const email = vi.fn(async () => {});
    const whatsapp = vi.fn(async () => {});
    const d = { ...deps(), sendTelegram: telegram, sendEmail: email, sendWhatsapp: whatsapp };
    // An account that never paid: $40 spent before today, $6 today.
    orgCents.set("org-unpaid", 4000);
    const acc = await distryGate(d, account("org-unpaid"));
    expect(acc).toMatchObject({ run: true, tracked: true });
    orgCents.set("org-unpaid", 4600);
    // A guest: two turns ($12 under our org) and a new plan org ($3).
    const g = await distryGate(d, guest("f"));
    await recordDistryTurn(d, g, "run-f1", `plan-${tag}-f`);
    await recordDistryTurn(d, g, "run-f2", `plan-${tag}-f`);
    runCents.set("run-f1", 700);
    runCents.set("run-f2", 500);
    orgCents.set(`plan-${tag}-f`, 300);
    expect(await refreshDistrySpendDay(d)).toMatchObject({ spendCents: 2100, thresholdCents: 3000, alerted: [] });
    expect(telegram).not.toHaveBeenCalled();
    expect(whatsapp).not.toHaveBeenCalled();
    expect(email).not.toHaveBeenCalled();
    runCents.set("run-f2", 1400); // 600 + 2100 + 300 = $30
    expect(await refreshDistrySpendDay(d)).toMatchObject({ spendCents: 3000, alerted: ["telegram", "whatsapp", "email"] });
    expect(telegram).toHaveBeenCalledTimes(1);
    expect(whatsapp).toHaveBeenCalledTimes(1);
    expect(String(whatsapp.mock.calls[0]![0])).toContain("$30.00");
    expect(String(telegram.mock.calls[0]![0])).toContain("$30.00");
    expect(email).toHaveBeenCalledWith(expect.objectContaining({ day: "2026-11-19", spentUsd: "30.00", limitUsd: "30.00" }));
    // Every later measure that day: nothing sent again.
    runCents.set("run-f2", 5000);
    expect(await refreshDistrySpendDay(d)).toMatchObject({ alerted: [] });
    expect(telegram).toHaveBeenCalledTimes(1);
    expect(whatsapp).toHaveBeenCalledTimes(1);
    expect(email).toHaveBeenCalledTimes(1);
    // And the gate now reads the stored day: everyone non-client gets the notice.
    expect(await distryGate(d, guest("g"))).toMatchObject({ run: false, reason: "day_cap" });
  });

  it("a channel that failed is retried on the next measure; the one that delivered is never sent twice", async () => {
    const telegram = vi.fn(async () => ({ ok: true as const }));
    const email = vi.fn().mockRejectedValueOnce(new Error("transactional-email 502")).mockResolvedValue(undefined);
    const whatsapp = vi.fn().mockRejectedValueOnce(new Error("crm 502")).mockResolvedValue(undefined);
    const d = { ...deps(), sendTelegram: telegram, sendEmail: email, sendWhatsapp: whatsapp };
    const g = await distryGate(d, guest("h"));
    await recordDistryTurn(d, g, "run-h1", null);
    runCents.set("run-h1", 3500);
    expect(await refreshDistrySpendDay(d)).toMatchObject({ alerted: ["telegram"] });
    const [row] = await client`SELECT alert_error FROM distry_spend_days`;
    expect(row!.alert_error).toContain("transactional-email 502");
    expect(row!.alert_error).toContain("whatsapp: crm 502");
    expect(await refreshDistrySpendDay(d)).toMatchObject({ alerted: ["whatsapp", "email"] });
    expect(await refreshDistrySpendDay(d)).toMatchObject({ alerted: [] });
    expect(telegram).toHaveBeenCalledTimes(1);
    expect(whatsapp).toHaveBeenCalledTimes(2);
    expect(email).toHaveBeenCalledTimes(2);
  });

  it("the Monitoring series: one row per day with zeros, the spend, the limit, visitors cut, turns refused, the alert", async () => {
    const telegram = vi.fn(async () => ({ ok: true as const }));
    env = { DISTRY_NONCLIENT_DAILY_USD: "99", DISTRY_NONPAYER_DEBT_GROWTH_USD: "30" };
    const d = { ...deps(), sendTelegram: telegram, sendEmail: vi.fn(async () => {}), sendWhatsapp: vi.fn(async () => {}) };
    const g = await distryGate(d, guest("i"));
    await recordDistryTurn(d, g, "run-i1", null);
    runCents.set("run-i1", 600);
    expect(await distryGate(d, guest("i"))).toMatchObject({ run: false, reason: "person_cap" });
    expect(await distryGate(d, guest("i"))).toMatchObject({ run: false, reason: "person_cap" });
    runCents.set("run-i1", 3100);
    await refreshDistrySpendDay(d);
    expect(await distryGate(d, guest("j"))).toMatchObject({ run: false, reason: "day_cap" });
    const days = await distrySpendDaysSeries(db, 3, now, env);
    expect(days.map((x) => x.day)).toEqual(["2026-11-17", "2026-11-18", "2026-11-19"]);
    expect(days[0]).toEqual({ day: "2026-11-17", nonClientSpendUsd: 0, thresholdUsd: 30, visitorsCut: 0, turnsRefusedByDayCap: 0, alertFired: false, alertFiredAt: null, measuredAt: null });
    expect(days[2]).toMatchObject({ nonClientSpendUsd: 31, thresholdUsd: 30, visitorsCut: 1, turnsRefusedByDayCap: 1, alertFired: true });
  });

  it("SOLO-PLAN-1125: a solo-plan account at -$2 gets the fixed notice with billing's upgrade link, no model; under it, it runs", async () => {
    const org = "org-staff-solo";
    solo.set(org, { on_solo_plan: true, may_use_our_keys: false, refused_reason: "debt_limit", debt_cents: "200.0000000000", debt_limit_cents: 200, upgrade_url: UPGRADE });
    const v = await distryGate(deps(), account(org));
    expect(v).toMatchObject({ run: false, reason: "plan_limit", notice: soloPlanLimitNotice(UPGRADE) });
    expect(soloPlanLimitNotice(UPGRADE)).toContain(UPGRADE);
    expect(soloPlanLimitNotice(UPGRADE)).not.toMatch(/dashboard|free|gift|[\u2014\u2013]/i);
    const [row] = await client`SELECT verdict, person_key FROM distry_spend_turns WHERE verdict = 'plan_limit'`;
    expect(row).toEqual({ verdict: "plan_limit", person_key: `org:${org}` });
    // Room left on the plan (debt $1.50): the turn runs, tracked as a non-payer's.
    solo.set(org, { on_solo_plan: true, may_use_our_keys: true, refused_reason: null, debt_cents: "150.0000000000", debt_limit_cents: 200, upgrade_url: UPGRADE });
    expect(await distryGate(deps(), account(org))).toMatchObject({ run: true, tracked: true });
  });

  it("SOLO-PLAN-1125: a paid solo plan out of credit stops too; an org on its own Claude never; a legacy account is untouched", async () => {
    solo.set("org-solo-paid", { on_solo_plan: true, may_use_our_keys: false, refused_reason: "out_of_credit", debt_cents: "0", debt_limit_cents: null, upgrade_url: UPGRADE });
    paying.add("org-solo-paid");
    expect(await distryGate(deps(), account("org-solo-paid"))).toMatchObject({ run: false, reason: "plan_limit" });
    solo.set("org-solo-local", { on_solo_plan: true, may_use_our_keys: false, refused_reason: "debt_limit", debt_cents: "250", debt_limit_cents: 200, upgrade_url: null });
    localOrgs.add("org-solo-local");
    expect(await distryGate(deps(), account("org-solo-local"))).toMatchObject({ run: true });
    expect(soloPlanLimitNotice(null)).not.toContain("http");
    paying.add("org-legacy");
    expect(await distryGate(deps(), account("org-legacy"))).toMatchObject({ run: true, tracked: false });
  });

  it("SOLO-PLAN-1125: billing unreadable fails the turn loudly, never answers on an unknown verdict", async () => {
    const d = { ...deps(), soloAiGate: vi.fn(async () => { throw new Error("billing-service solo-plan ai-gate 502"); }) };
    await expect(distryGate(d, account("org-x"))).rejects.toThrow(/ai-gate 502/);
  });
});
