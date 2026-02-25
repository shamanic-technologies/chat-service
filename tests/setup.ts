import { beforeAll, afterAll } from "vitest";

// Test setup - load env vars for integration tests
beforeAll(() => {
  process.env.CHAT_SERVICE_DATABASE_URL =
    process.env.CHAT_SERVICE_DATABASE_URL || "postgresql://localhost/chat_test";
  process.env.KEY_SERVICE_URL =
    process.env.KEY_SERVICE_URL || "https://key.test.local";
  process.env.KEY_SERVICE_API_KEY =
    process.env.KEY_SERVICE_API_KEY || "test-key-svc-key";
});

afterAll(() => {
  // cleanup
});
