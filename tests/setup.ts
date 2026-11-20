import { beforeAll, afterAll } from "vitest";

// Test setup - load env vars for integration tests
// The one key every test calling chat-service sends (SEC-CHAT-IDENTITY-1120:
// the middleware compares the value, so a test using another string is refused).
process.env.CHAT_SERVICE_API_KEY = "test-key";

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
