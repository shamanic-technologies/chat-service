import { describe, it, expect } from "vitest";
import {
  resolveChatProviderModel,
  buildConfigConflictSet,
  DEFAULT_CHAT_PROVIDER,
} from "../../src/lib/config-defaults.js";

describe("resolveChatProviderModel — default provider/model", () => {
  it("NULL provider + NULL model → google/pro (Gemini is the platform default)", () => {
    // Regression: this previously resolved to anthropic/sonnet, which 400'd
    // once the Anthropic platform key ran out of credit.
    expect(resolveChatProviderModel({ provider: null, model: null })).toEqual({
      provider: "google",
      modelAlias: "pro",
    });
  });

  it("DEFAULT_CHAT_PROVIDER is google", () => {
    expect(DEFAULT_CHAT_PROVIDER).toBe("google");
  });

  it("NULL provider + explicit model keeps google as provider", () => {
    expect(resolveChatProviderModel({ provider: null, model: "flash" })).toEqual({
      provider: "google",
      modelAlias: "flash",
    });
  });

  it("explicit anthropic + NULL model → anthropic/sonnet", () => {
    expect(resolveChatProviderModel({ provider: "anthropic", model: null })).toEqual({
      provider: "anthropic",
      modelAlias: "sonnet",
    });
  });

  it("explicit google + flash → google/flash", () => {
    expect(resolveChatProviderModel({ provider: "google", model: "flash" })).toEqual({
      provider: "google",
      modelAlias: "flash",
    });
  });

  it("explicit anthropic + opus → anthropic/opus (explicit always wins)", () => {
    expect(resolveChatProviderModel({ provider: "anthropic", model: "opus" })).toEqual({
      provider: "anthropic",
      modelAlias: "opus",
    });
  });
});

describe("buildConfigConflictSet — re-registration keep-existing", () => {
  const base = { systemPrompt: "You are helpful.", allowedTools: ["request_user_input"] };

  it("omits provider/model when not supplied (preserves stored override)", () => {
    // Regression: registration used `provider: provider ?? null`, which reset an
    // explicitly-set provider back to NULL on every re-register / redeploy.
    const set = buildConfigConflictSet({ ...base });
    expect(set).not.toHaveProperty("provider");
    expect(set).not.toHaveProperty("model");
    expect(set.systemPrompt).toBe("You are helpful.");
    expect(set.allowedTools).toEqual(["request_user_input"]);
  });

  it("includes provider + model when both supplied", () => {
    const set = buildConfigConflictSet({ ...base, provider: "google", model: "pro" });
    expect(set.provider).toBe("google");
    expect(set.model).toBe("pro");
  });

  it("includes provider only when model omitted", () => {
    const set = buildConfigConflictSet({ ...base, provider: "anthropic" });
    expect(set.provider).toBe("anthropic");
    expect(set).not.toHaveProperty("model");
  });
});
