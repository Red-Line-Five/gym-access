import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Meta signs every webhook with HMAC-SHA256 of the raw body using your App Secret,
 * sent as `X-Hub-Signature-256: sha256=<hex>`. Always verify before trusting a webhook.
 */
export function verifySignature(rawBody: string | Uint8Array, header: string | null | undefined, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  let given: Buffer;
  try {
    given = Buffer.from(header.slice("sha256=".length), "hex");
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export interface MessageStatus {
  messageId: string;
  status: "sent" | "delivered" | "read" | "failed" | string;
  recipient: string;
  errorCode?: number;
  errorTitle?: string;
}

/** Pull delivery statuses out of a webhook payload. */
export function parseStatuses(payload: unknown): MessageStatus[] {
  const out: MessageStatus[] = [];
  const entries = (payload as { entry?: unknown[] } | null)?.entry ?? [];
  for (const entry of entries) {
    for (const change of (entry as { changes?: unknown[] }).changes ?? []) {
      const statuses = (change as { value?: { statuses?: unknown[] } }).value?.statuses ?? [];
      for (const s of statuses as Array<{
        id: string;
        status: string;
        recipient_id: string;
        errors?: Array<{ code?: number; title?: string }>;
      }>) {
        const status: MessageStatus = { messageId: s.id, status: s.status, recipient: s.recipient_id };
        const err = s.errors?.[0];
        if (err?.code !== undefined) status.errorCode = err.code;
        if (err?.title) status.errorTitle = err.title;
        out.push(status);
      }
    }
  }
  return out;
}
