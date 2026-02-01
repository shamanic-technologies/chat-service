import { beforeAll, afterAll } from "vitest";

// Test setup - load env vars for integration tests
beforeAll(() => {
  process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || "test-key";
  process.env.CHAT_SERVICE_DATABASE_URL =
    process.env.CHAT_SERVICE_DATABASE_URL || "postgresql://localhost/chat_test";
});

afterAll(() => {
  // cleanup
});
