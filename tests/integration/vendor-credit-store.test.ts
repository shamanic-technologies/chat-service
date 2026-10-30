import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { sql } from "drizzle-orm";

// VENDOR-CREDIT-1030: the out-of-credit fact lands in Postgres (one open outage
// per provider + a per-day counter) and the staff read serves it.
process.env.NODE_ENV = "test";

describe("vendor credit: stored fact + GET /internal/vendor-credit", () => {
  let app: Awaited<ReturnType<typeof loadApp>>;
  let db: typeof import("../../src/db/index.js").db;
  let storeMod: typeof import("../../src/lib/vendor-credit-store.js");
  async function loadApp() {
    vi.resetModules();
    return (await import("../../src/index.js")).default;
  }
  beforeAll(async () => {
    app = await loadApp();
    db = (await import("../../src/db/index.js")).db;
    storeMod = await import("../../src/lib/vendor-credit-store.js");
  });
  beforeEach(async () => {
    await db.execute(sql`DELETE FROM vendor_credit_outages`);
    await db.execute(sql`DELETE FROM vendor_credit_days`);
  });

  it("opens ONE outage per provider, counts refusals and reroutes per day, closes on recovery", async () => {
    const store = storeMod.createVendorCreditStore(db);
    const t1 = new Date("2026-10-29T15:59:46Z");
    const t2 = new Date("2026-10-29T23:10:27Z");
    await Promise.all([
      store.recordRefusal({ provider: "deepseek", model: "deepseek-flash", at: t1, message: "Insufficient Balance" }),
      store.recordRefusal({ provider: "deepseek", model: "deepseek-flash", at: t1, message: "Insufficient Balance" }),
    ]);
    await store.recordRefusal({ provider: "deepseek", model: "deepseek-flash", at: t2, message: "Insufficient Balance" });
    await store.recordReroute({ provider: "deepseek", at: t2 });
    expect(await store.loadOpen()).toEqual([{ provider: "deepseek", firstSeenAt: t1 }]);

    const res = await request(app).get("/internal/vendor-credit?days=2").set({ "x-api-key": "test-key" });
    expect(res.status).toBe(200);
    const ds = res.body.vendors[0];
    expect(ds).toMatchObject({ provider: "deepseek", outOfCredit: true, since: t1.toISOString(), lastSeenAt: t2.toISOString(), refusedCalls: 3, reroutedCalls: 1, fallbackModel: "glm-5.3-flash" });
    expect(res.body.vendors).toHaveLength(6);

    await store.closeOutage({ provider: "deepseek", at: new Date("2026-10-30T09:00:00Z") });
    expect(await store.loadOpen()).toEqual([]);
    const after = await request(app).get("/internal/vendor-credit?days=30").set({ "x-api-key": "test-key" });
    const ds2 = after.body.vendors.find((v: { provider: string }) => v.provider === "deepseek");
    expect(ds2.outOfCredit).toBe(false);
    expect(ds2.recoveredAt).toBe("2026-10-30T09:00:00.000Z");
    const day = after.body.days.find((d: { provider: string; day: string }) => d.provider === "deepseek" && d.day === "2026-10-29");
    if (day) expect(day).toMatchObject({ outOfCredit: true, refusedCalls: 3, reroutedCalls: 1 });

    // A new outage after recovery opens a new row.
    await store.recordRefusal({ provider: "deepseek", model: "deepseek-flash", at: new Date(), message: "x" });
    expect((await store.loadOpen()).map((o) => o.provider)).toEqual(["deepseek"]);
  });

  it("rejects days outside 1..90", async () => {
    const res = await request(app).get("/internal/vendor-credit?days=0").set({ "x-api-key": "test-key" });
    expect(res.status).toBe(400);
  });
});
