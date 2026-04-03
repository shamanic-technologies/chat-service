import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Regression test for duplicate fork bug.
 *
 * When the LLM calls update_workflow multiple times with the same workflowId
 * in a single chat turn, the first call may trigger a fork (201). Subsequent
 * calls must target the already-forked workflow ID, NOT the original — otherwise
 * each call creates a new fork from the same parent.
 *
 * The fix uses a `forkedWorkflowMap` (Map<string, string>) that tracks
 * originalWorkflowId → forkedWorkflowId within a single turn.
 */

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.ADMIN_DISTRIBUTE_API_KEY = "test-api-svc-key";
  process.env.API_SERVICE_URL = "https://api.test.local";
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

async function loadModule() {
  vi.resetModules();
  return import("../../src/lib/workflow-client.js");
}

/**
 * Simulate the fork-dedup logic from src/index.ts executeTool handler.
 * This mirrors the actual runtime behavior without needing the full Express stack.
 */
function createForkDedup() {
  const forkedWorkflowMap = new Map<string, string>();

  return {
    forkedWorkflowMap,
    /**
     * Resolve the effective workflowId: if the original was already forked
     * in this turn, return the forked ID instead.
     */
    resolveWorkflowId(rawWorkflowId: string): string {
      return forkedWorkflowMap.get(rawWorkflowId) ?? rawWorkflowId;
    },
    /**
     * Record a fork: subsequent calls with the same original ID will be redirected.
     */
    recordFork(originalId: string, forkedId: string): void {
      forkedWorkflowMap.set(originalId, forkedId);
    },
  };
}

describe("fork deduplication (forkedWorkflowMap)", () => {
  it("first call uses the original workflowId", () => {
    const dedup = createForkDedup();
    expect(dedup.resolveWorkflowId("wf-original")).toBe("wf-original");
  });

  it("after a fork, subsequent calls redirect to the forked ID", () => {
    const dedup = createForkDedup();

    // First call triggers a fork
    const id1 = dedup.resolveWorkflowId("wf-original");
    expect(id1).toBe("wf-original");
    dedup.recordFork("wf-original", "wf-forked-1");

    // Second call redirects to the fork
    const id2 = dedup.resolveWorkflowId("wf-original");
    expect(id2).toBe("wf-forked-1");

    // Third call also redirects
    const id3 = dedup.resolveWorkflowId("wf-original");
    expect(id3).toBe("wf-forked-1");
  });

  it("different source workflows are tracked independently", () => {
    const dedup = createForkDedup();

    dedup.recordFork("wf-A", "wf-A-forked");
    dedup.recordFork("wf-B", "wf-B-forked");

    expect(dedup.resolveWorkflowId("wf-A")).toBe("wf-A-forked");
    expect(dedup.resolveWorkflowId("wf-B")).toBe("wf-B-forked");
    expect(dedup.resolveWorkflowId("wf-C")).toBe("wf-C"); // untouched
  });

  it("prevents duplicate forks when LLM calls update_workflow 4 times on same source", async () => {
    const { updateWorkflow } = await loadModule();
    const dedup = createForkDedup();

    let forkCount = 0;

    // Mock: first PUT returns 201 (fork), subsequent PUTs return 200 (in-place update)
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      if (url.includes("/v1/workflows/wf-original")) {
        forkCount++;
        return {
          ok: true,
          status: 201,
          json: () =>
            Promise.resolve({
              id: `wf-forked-${forkCount}`,
              name: `PR Cold Email Outreach Fork ${forkCount}`,
              _action: "forked",
              _forkedFromName: "PR Cold Email Outreach Ithaca",
            }),
        };
      }
      // Calls to the already-forked workflow update in-place
      return {
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            id: url.split("/v1/workflows/")[1],
            name: "PR Cold Email Outreach Fork 1",
            _action: "updated",
          }),
      };
    });

    const params = { orgId: "org-1", userId: "user-1", runId: "run-1" };

    // Simulate 4 LLM tool calls to update_workflow with the same source workflowId
    const results = [];
    for (let i = 0; i < 4; i++) {
      const effectiveId = dedup.resolveWorkflowId("wf-original");
      const result = await updateWorkflow(
        effectiveId,
        { description: `change ${i}` },
        params,
      );
      if (result.outcome === "forked") {
        dedup.recordFork("wf-original", result.workflow.id);
      }
      results.push(result);
    }

    // Only the first call should hit the original workflow (and fork)
    expect(results[0].outcome).toBe("forked");
    expect(results[0].workflow.id).toBe("wf-forked-1");

    // Subsequent calls should target the forked workflow (in-place updates)
    expect(results[1].outcome).toBe("updated");
    expect(results[2].outcome).toBe("updated");
    expect(results[3].outcome).toBe("updated");

    // Verify only 1 call went to the original, rest went to the fork
    const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls;
    const originalCalls = calls.filter((c) => (c[0] as string).includes("wf-original"));
    const forkedCalls = calls.filter((c) => (c[0] as string).includes("wf-forked-1"));
    expect(originalCalls).toHaveLength(1);
    expect(forkedCalls).toHaveLength(3);
  });
});
