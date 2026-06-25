import crypto from "crypto";

const SERVICE_NAME = "chat-service";

export interface CloudflareUploadResult {
  id: string;
  url: string;
  size: number;
  contentType: string;
}

export type CloudflareUploadScope =
  | {
      type: "org";
      orgId: string;
      userId: string;
      runId: string;
      trackingHeaders?: Record<string, string>;
    }
  | { type: "platform" };

export interface UploadGeneratedImageParams {
  imageBase64: string;
  mimeType: string;
  folder: string;
  filename?: string;
  scope: CloudflareUploadScope;
}

function cloudflareConfig(): { baseUrl: string; apiKey: string } {
  const baseUrl = process.env.CLOUDFLARE_SERVICE_URL;
  const apiKey = process.env.CLOUDFLARE_SERVICE_API_KEY;
  if (!baseUrl) {
    throw new Error("[cloudflare-client] CLOUDFLARE_SERVICE_URL is required");
  }
  if (!apiKey) {
    throw new Error("[cloudflare-client] CLOUDFLARE_SERVICE_API_KEY is required");
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey };
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/gif") return "gif";
  return "png";
}

function uploadHeaders(apiKey: string, scope: CloudflareUploadScope): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
  };

  if (scope.type === "platform") {
    headers["x-service-name"] = SERVICE_NAME;
    return headers;
  }

  headers["x-org-id"] = scope.orgId;
  headers["x-user-id"] = scope.userId;
  headers["x-run-id"] = scope.runId;
  for (const [key, value] of Object.entries(scope.trackingHeaders ?? {})) {
    if (value) headers[key] = value;
  }
  return headers;
}

function uploadPath(scope: CloudflareUploadScope): string {
  return scope.type === "platform" ? "/internal/upload/base64" : "/upload/base64";
}

function assertCloudflareUploadResult(value: unknown): CloudflareUploadResult {
  if (!value || typeof value !== "object") {
    throw new Error("[cloudflare-client] Cloudflare upload returned an invalid JSON body");
  }
  const body = value as Partial<CloudflareUploadResult>;
  if (
    typeof body.id !== "string" ||
    typeof body.url !== "string" ||
    typeof body.size !== "number" ||
    typeof body.contentType !== "string"
  ) {
    throw new Error("[cloudflare-client] Cloudflare upload response is missing id, url, size, or contentType");
  }
  return {
    id: body.id,
    url: body.url,
    size: body.size,
    contentType: body.contentType,
  };
}

export async function uploadGeneratedImageToCloudflare(
  params: UploadGeneratedImageParams,
): Promise<CloudflareUploadResult> {
  const { baseUrl, apiKey } = cloudflareConfig();
  const filename =
    params.filename ?? `${crypto.randomUUID()}.${extensionForMimeType(params.mimeType)}`;

  const res = await fetch(`${baseUrl}${uploadPath(params.scope)}`, {
    method: "POST",
    headers: uploadHeaders(apiKey, params.scope),
    body: JSON.stringify({
      contentBase64: params.imageBase64,
      folder: params.folder,
      filename,
      contentType: params.mimeType,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`[cloudflare-client] POST ${uploadPath(params.scope)} returned ${res.status}: ${text}`);
  }

  return assertCloudflareUploadResult(await res.json());
}
