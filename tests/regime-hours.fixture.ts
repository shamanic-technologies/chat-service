/**
 * costs-service `GET /v1/platform-prices` regime rows, read in PROD on 2026-11-25 (v0.90.0): the
 * `regimeHoursUtc` chat-service decides peak vs off-peak from (DEEPSEEK-HOLIDAYS-1124). Loaded for
 * every test file by `tests/setup.ts`, as `refreshFallbackPrices` does at boot in production.
 */
const HOURS: Record<string, { regime: string; hours: string }> = {
  "deepseek-v4.1-flash-off-peak": { regime: "off-peak", hours: "Mon-Fri@00:00-01:00,Mon-Fri@04:00-06:00,Mon-Fri@10:00-24:00,Sat-Sun@00:00-24:00,2026-01-01..2026-01-03@00:00-24:00,2026-02-15..2026-02-23@00:00-24:00,2026-04-04..2026-04-06@00:00-24:00,2026-05-01..2026-05-05@00:00-24:00,2026-06-19..2026-06-21@00:00-24:00,2026-09-25..2026-09-27@00:00-24:00,2026-10-01..2026-10-07@00:00-24:00,2027-01-01..2027-01-03@00:00-24:00,2027-02-05..2027-02-13@00:00-24:00,2027-04-03..2027-04-05@00:00-24:00,2027-05-01..2027-05-05@00:00-24:00,2027-06-09@00:00-24:00,2027-09-15@00:00-24:00,2027-10-01..2027-10-07@00:00-24:00" },
  "deepseek-v4.1-flash-peak": { regime: "peak", hours: "Mon-Fri@01:00-04:00,Mon-Fri@06:00-10:00,!2026-01-01..2026-01-03@00:00-24:00,!2026-02-15..2026-02-23@00:00-24:00,!2026-04-04..2026-04-06@00:00-24:00,!2026-05-01..2026-05-05@00:00-24:00,!2026-06-19..2026-06-21@00:00-24:00,!2026-09-25..2026-09-27@00:00-24:00,!2026-10-01..2026-10-07@00:00-24:00,!2027-01-01..2027-01-03@00:00-24:00,!2027-02-05..2027-02-13@00:00-24:00,!2027-04-03..2027-04-05@00:00-24:00,!2027-05-01..2027-05-05@00:00-24:00,!2027-06-09@00:00-24:00,!2027-09-15@00:00-24:00,!2027-10-01..2027-10-07@00:00-24:00" },
  "deepseek-v4-flash-off-peak": { regime: "off-peak", hours: "Mon-Fri@00:00-01:00,Mon-Fri@04:00-06:00,Mon-Fri@10:00-24:00,Sat-Sun@00:00-24:00" },
  "deepseek-v4-flash-peak": { regime: "peak", hours: "Mon-Fri@01:00-04:00,Mon-Fri@06:00-10:00" },
  "deepseek-v4-pro-off-peak": { regime: "off-peak", hours: "Mon-Fri@00:00-01:00,Mon-Fri@04:00-06:00,Mon-Fri@10:00-24:00,Sat-Sun@00:00-24:00" },
  "deepseek-v4-pro-peak": { regime: "peak", hours: "Mon-Fri@01:00-04:00,Mon-Fri@06:00-10:00" },
};

export const REGIME_ROWS_2026_11_25: Array<{ name: string; pricingRegime: string; regimeHoursUtc: string }> =
  Object.entries(HOURS).flatMap(([prefix, { regime, hours }]) =>
    ["tokens-input", "tokens-cached-input", "tokens-output"].map((suffix) => ({
      name: `${prefix}-${suffix}`,
      pricingRegime: regime,
      regimeHoursUtc: hours,
    })),
  );

/**
 * Load the rows into the CURRENT module registry. A test that calls `vi.resetModules()` gets a fresh
 * `cost-names` module with nothing read (as a fresh boot would), so it loads them again right after.
 */
export async function loadRegimeCatalogue(): Promise<void> {
  (await import("../src/lib/cost-names.js")).setRegimeCatalogue(REGIME_ROWS_2026_11_25);
}
