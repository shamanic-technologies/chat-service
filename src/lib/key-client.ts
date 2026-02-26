const KEY_SERVICE_URL =
  process.env.KEY_SERVICE_URL || "https://key.mcpfactory.org";
const KEY_SERVICE_API_KEY = process.env.KEY_SERVICE_API_KEY;

const CALLER_SERVICE = "chat";

export interface CallerInfo {
  method: string;
  path: string;
}

export interface DecryptedKey {
  provider: string;
  key: string;
}

export async function decryptAppKey(
  provider: string,
  appId: string,
  caller: CallerInfo,
): Promise<DecryptedKey> {
  if (!KEY_SERVICE_API_KEY) {
    throw new Error(
      "[key-client] KEY_SERVICE_API_KEY is required to decrypt app keys",
    );
  }

  const url = `${KEY_SERVICE_URL}/internal/app-keys/${encodeURIComponent(provider)}/decrypt?appId=${encodeURIComponent(appId)}`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "x-api-key": KEY_SERVICE_API_KEY,
      "X-Caller-Service": CALLER_SERVICE,
      "X-Caller-Method": caller.method,
      "X-Caller-Path": caller.path,
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[key-client] GET /internal/app-keys/${provider}/decrypt returned ${res.status}: ${text}`,
    );
  }

  return (await res.json()) as DecryptedKey;
}

export async function decryptOrgKey(
  provider: string,
  orgId: string,
  caller: CallerInfo,
): Promise<DecryptedKey> {
  if (!KEY_SERVICE_API_KEY) {
    throw new Error(
      "[key-client] KEY_SERVICE_API_KEY is required to decrypt org keys",
    );
  }

  const url = `${KEY_SERVICE_URL}/internal/keys/${encodeURIComponent(provider)}/decrypt?orgId=${encodeURIComponent(orgId)}`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "x-api-key": KEY_SERVICE_API_KEY,
      "X-Caller-Service": CALLER_SERVICE,
      "X-Caller-Method": caller.method,
      "X-Caller-Path": caller.path,
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[key-client] GET /internal/keys/${provider}/decrypt returned ${res.status}: ${text}`,
    );
  }

  return (await res.json()) as DecryptedKey;
}
