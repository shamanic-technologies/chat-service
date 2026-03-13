import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { requireInternalAuth } from "../../src/middleware/auth.js";

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

describe("requireInternalAuth middleware", () => {
  it("returns 401 when x-api-key header is missing", () => {
    const { req, res, next } = mockReqRes({});
    requireInternalAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: "x-api-key header is required",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next when x-api-key is present (no org/user/run headers needed)", () => {
    const { req, res, next } = mockReqRes({
      "x-api-key": "test-key",
    });
    requireInternalAuth(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("does not require x-org-id, x-user-id, or x-run-id", () => {
    const { req, res, next } = mockReqRes({
      "x-api-key": "test-key",
    });
    requireInternalAuth(req, res, next);
    expect(next).toHaveBeenCalled();
    // Should not set any locals
    expect(res.locals).toEqual({});
  });
});
