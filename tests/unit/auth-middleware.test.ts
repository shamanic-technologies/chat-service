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

  it("calls next and sets locals when all headers are present", () => {
    const { req, res, next } = mockReqRes({
      "x-api-key": "test-key",
      "x-org-id": "org-123",
      "x-user-id": "user-456",
    });
    requireAuth(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.locals.orgId).toBe("org-123");
    expect(res.locals.userId).toBe("user-456");
    expect(res.status).not.toHaveBeenCalled();
  });
});
