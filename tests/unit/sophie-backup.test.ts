// SOPHIE-HAIKU-BACKUP-1112 (prod 2026-11-11): the DeepSeek balance ran out and every Sophie turn
// failed overnight. While her vendor is out of credit, her turn runs on Claude Haiku 5.5.
import { afterEach, describe, expect, it } from "vitest";
import { SOPHIE_BACKUP_MODEL, sophieTurnModel } from "../../src/agent/sophie-backup.js";
import { SOPHIE_CONFIG_KEY, SOPHIE_MODEL } from "../../src/agent/sophie.js";
import { markProviderServing, recordOutOfCredit, resetVendorCredit } from "../../src/lib/vendor-credit.js";
import { resolveModel } from "../../src/lib/anthropic.js";

const primary = { provider: SOPHIE_MODEL.provider, modelAlias: SOPHIE_MODEL.model };

afterEach(() => resetVendorCredit());

describe("Sophie's backup model", () => {
  it("runs on her own model while her vendor has credit", () => {
    expect(sophieTurnModel(SOPHIE_CONFIG_KEY, primary)).toEqual({ ...primary, backupFor: null });
  });

  it("runs the whole turn on Haiku 5.5 while her vendor is out of credit, and returns once it serves again", () => {
    recordOutOfCredit({ provider: SOPHIE_MODEL.provider, model: "deepseek-flash", status: 402, message: "Insufficient Balance" });
    const backup = sophieTurnModel(SOPHIE_CONFIG_KEY, primary);
    expect(backup).toEqual({ provider: "anthropic", modelAlias: SOPHIE_BACKUP_MODEL.model, backupFor: SOPHIE_MODEL.provider });
    // Haiku 5.5, never Haiku 4.5 (owner rule), priced by the catalog.
    expect(resolveModel(backup.provider, backup.modelAlias)).toMatchObject({ apiModelId: "claude-haiku-5-5", costPrefix: "anthropic-haiku-5.5" });
    markProviderServing(SOPHIE_MODEL.provider);
    expect(sophieTurnModel(SOPHIE_CONFIG_KEY, primary).backupFor).toBeNull();
  });

  it("leaves every other chat config on its own model", () => {
    recordOutOfCredit({ provider: SOPHIE_MODEL.provider, model: "deepseek-flash", status: 402, message: "Insufficient Balance" });
    expect(sophieTurnModel("workflow", primary)).toEqual({ ...primary, backupFor: null });
  });
});
