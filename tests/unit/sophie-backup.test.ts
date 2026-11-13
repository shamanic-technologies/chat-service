// SOPHIE-HAIKU-BACKUP-1112 (prod 2026-11-11): the DeepSeek balance ran out and every Sophie turn
// failed overnight. While her vendor is out of credit, her turn runs on her backup model.
// SOPHIE-ON-HAIKU-1113 (owner 2026-11-13): Haiku 5.5 became her model, DeepSeek V4.1 Flash her backup.
import { afterEach, describe, expect, it } from "vitest";
import { SOPHIE_BACKUP_MODEL, sophieTurnModel } from "../../src/agent/sophie-backup.js";
import { SOPHIE_CONFIG_KEY, SOPHIE_MODEL } from "../../src/agent/sophie.js";
import { markProviderServing, recordOutOfCredit, resetVendorCredit } from "../../src/lib/vendor-credit.js";
import { resolveModel } from "../../src/lib/anthropic.js";

const primary = { provider: SOPHIE_MODEL.provider, modelAlias: SOPHIE_MODEL.model };

afterEach(() => resetVendorCredit());

describe("Sophie's model", () => {
  it("is Claude Haiku 5.5 (never Haiku 4.5, owner rule) at effort low", () => {
    expect(resolveModel(SOPHIE_MODEL.provider, SOPHIE_MODEL.model)).toMatchObject({ apiModelId: "claude-haiku-5-5", costPrefix: "anthropic-haiku-5.5" });
    expect(SOPHIE_MODEL.effort).toBe("low");
  });
});

describe("Sophie's backup model", () => {
  it("runs on her own model while her vendor has credit", () => {
    expect(sophieTurnModel(SOPHIE_CONFIG_KEY, primary)).toEqual({ ...primary, backupFor: null });
  });

  it("runs the whole turn on DeepSeek V4.1 Flash while Anthropic is out of credit, and returns once it serves again", () => {
    recordOutOfCredit({ provider: SOPHIE_MODEL.provider, model: "claude-haiku-5-5", status: 400, message: "Your credit balance is too low to access the Anthropic API." });
    const backup = sophieTurnModel(SOPHIE_CONFIG_KEY, primary);
    expect(backup).toEqual({ provider: "deepseek", modelAlias: SOPHIE_BACKUP_MODEL.model, backupFor: SOPHIE_MODEL.provider });
    expect(resolveModel(backup.provider, backup.modelAlias)).toMatchObject({ apiModelId: "deepseek-flash" });
    // Reasoning on, as measured (no reasoning-off field sent).
    expect(SOPHIE_BACKUP_MODEL.reasoning).toBe("on");
    markProviderServing(SOPHIE_MODEL.provider);
    expect(sophieTurnModel(SOPHIE_CONFIG_KEY, primary).backupFor).toBeNull();
  });

  it("leaves every other chat config on its own model", () => {
    recordOutOfCredit({ provider: SOPHIE_MODEL.provider, model: "claude-haiku-5-5", status: 400, message: "Your credit balance is too low to access the Anthropic API." });
    expect(sophieTurnModel("workflow", primary)).toEqual({ ...primary, backupFor: null });
  });
});
