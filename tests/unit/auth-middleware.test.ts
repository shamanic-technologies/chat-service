import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { requireAuth } from "../../src/middleware/auth.js";

function mockReqRes(headers: Record<string, string> = {}) {
  const req = { headers } as unknown as Request;
  const res = {
    locals: {} as Record<string, unknown>,
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  const next = vi.fn() as NextFunction;
  return { req, res, next };
}

describe("requireAuth middleware", () => {
  it("returns 401 when x-api-key header is missing", () => {
    const { req, res, next } = mockReqRes({});
    requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: "x-api-key header is required",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 400 when x-org-id is missing", () => {
    const { req, res, next } = mockReqRes({
      "x-api-key": "test-key",
      "x-user-id": "user-123",
    });
    requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: "x-org-id header is required",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 400 when x-user-id is missing", () => {
    const { req, res, next } = mockReqRes({
      "x-api-key": "test-key",
      "x-org-id": "org-123",
    });
    requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: "x-user-id header is required",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 400 when x-run-id is missing", () => {
    const { req, res, next } = mockReqRes({
      "x-api-key": "test-key",
      "x-org-id": "org-123",
      "x-user-id": "user-456",
    });
    requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: "x-run-id header is required",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next and sets locals when all headers are present", () => {
    const { req, res, next } = mockReqRes({
      "x-api-key": "test-key",
      "x-org-id": "org-123",
      "x-user-id": "user-456",
      "x-run-id": "run-789",
    });
    requireAuth(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.locals.orgId).toBe("org-123");
    expect(res.locals.userId).toBe("user-456");
    expect(res.locals.parentRunId).toBe("run-789");
    expect(res.status).not.toHaveBeenCalled();
  });

  // SEC-CHAT-IDENTITY-1120 (prod 2026-11-20): the attacker sent a key of its own
  // choosing with Martian DBB's org + user and Sophie answered as that user.
  it("refuses a caller whose x-api-key is not the service key, whatever org/user it states", () => {
    const { req, res, next } = mockReqRes({
      "x-api-key": "anything-the-attacker-typed",
      "x-org-id": "cb9ad98a-d572-4fe7-9dd9-7dbce61d8373",
      "x-user-id": "ffedbb3d-05c7-49bd-85e4-c356e8a07e14",
      "x-run-id": "22222222-2222-4222-8222-222222222222",
    });
    requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "Invalid API key" });
    expect(next).not.toHaveBeenCalled();
    expect(res.locals.orgId).toBeUndefined();
  });

  it("refuses every caller (503) when the service key is not configured", () => {
    const saved = process.env.CHAT_SERVICE_API_KEY;
    delete process.env.CHAT_SERVICE_API_KEY;
    try {
      const { req, res, next } = mockReqRes({
        "x-api-key": "test-key",
        "x-org-id": "org-123",
        "x-user-id": "user-456",
        "x-run-id": "run-789",
      });
      requireAuth(req, res, next);
      expect(res.status).toHaveBeenCalledWith(503);
      expect(next).not.toHaveBeenCalled();
    } finally {
      process.env.CHAT_SERVICE_API_KEY = saved;
    }
  });
});
