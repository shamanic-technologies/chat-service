import { OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { registry } from "../src/schemas.js";
import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");

const generator = new OpenApiGeneratorV3(registry.definitions);

const document = generator.generateDocument({
  openapi: "3.0.0",
  info: {
    title: "Chat Service",
    description:
      "Backend chat service powering Foxy, the MCP Factory AI assistant. Streams Gemini AI responses via SSE with MCP tool calling support.",
    version: "1.0.0",
  },
  servers: [
    { url: process.env.CHAT_SERVICE_URL || "http://localhost:3002" },
  ],
});

writeFileSync(join(projectRoot, "openapi.json"), JSON.stringify(document, null, 2));
console.log("openapi.json generated");
