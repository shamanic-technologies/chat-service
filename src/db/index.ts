import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

const connectionString = process.env.CHAT_SERVICE_DATABASE_URL;

if (!connectionString) {
  throw new Error("CHAT_SERVICE_DATABASE_URL is required");
}

const client = postgres(connectionString);
export const db = drizzle(client, { schema });
