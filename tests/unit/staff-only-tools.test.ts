import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import {
  STAFF_ONLY_TOOLS,
  hasStaffOnlyTool,
  lookupRequester,
  toolsForRequester,
} from "../../src/lib/staff-only-tools.js";

const CONFIG_TOOLS = ["list_workflows", "get_prompt_template", "update_prompt_template", "read_skill"];

describe("staff-only Copilot tools", () => {
  it("covers the shared prompt-template tools", () => {
    expect([...STAFF_ONLY_TOOLS].sort()).toEqual(["get_prompt_template", "update_prompt_template"]);
    expect(hasStaffOnlyTool(CONFIG_TOOLS)).toBe(true);
    expect(hasStaffOnlyTool(["list_workflows"])).toBe(false);
  });

  it("staff keep the prompt tools", async () => {
    const requester = await lookupRequester("u-staff", async () => "kevin@distribute.you");
    expect(requester).toEqual({ email: "kevin@distribute.you", isStaff: true });
    expect(toolsForRequester(CONFIG_TOOLS, requester)).toEqual(CONFIG_TOOLS);
  });

  it("a customer never sees the prompt tools", async () => {
    const requester = await lookupRequester("u-client", async () => "founder@acme.com");
    expect(requester.isStaff).toBe(false);
    expect(toolsForRequester(CONFIG_TOOLS, requester)).toEqual(["list_workflows", "read_skill"]);
  });

  it("an unknown user or a failed lookup is a customer (fail closed)", async () => {
    const unknown = await lookupRequester("u-ghost", async () => null);
    expect(toolsForRequester(CONFIG_TOOLS, unknown)).toEqual(["list_workflows", "read_skill"]);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = await lookupRequester("u-x", async () => {
      throw new Error("client-service 503");
    });
    expect(failed).toEqual({ email: null, isStaff: false });
    expect(toolsForRequester(CONFIG_TOOLS, failed)).toEqual(["list_workflows", "read_skill"]);
    spy.mockRestore();
  });
});

describe("/chat wiring (source guard)", () => {
  const src = readFileSync(new URL("../../src/index.ts", import.meta.url), "utf8");

  it("filters the config's tools by requester before the tool set and guard are built", () => {
    const filterAt = src.indexOf("toolsForRequester(configToolNames, await getRequester())");
    const setAt = src.indexOf("const allowedToolSet = new Set(allowedToolNames)");
    expect(filterAt).toBeGreaterThan(-1);
    expect(setAt).toBeGreaterThan(filterAt);
  });

  it("both prompt tools forward the staff email", () => {
    const getAt = src.indexOf('if (call.name === "get_prompt_template")');
    const updAt = src.indexOf('if (call.name === "update_prompt_template")');
    const end = src.indexOf("// API Registry progressive disclosure tools", updAt);
    expect(src.slice(getAt, updAt)).toContain("staffEmail: await staffEmailOrThrow()");
    expect(src.slice(updAt, end)).toContain("staffEmail: await staffEmailOrThrow()");
  });
});
