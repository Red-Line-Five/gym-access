import { parseStatuses, verifySignature } from "@gym/whatsapp";

export interface StatusStore {
  applyStatus(waMessageId: string, status: string, error?: string): Promise<void>;
}

/** Meta's one-time check when you save the webhook URL: GET ?hub.mode=subscribe&hub.verify_token=...&hub.challenge=... */
export function verifyChallenge(query: URLSearchParams, verifyToken: string): string | null {
  return query.get("hub.mode") === "subscribe" && query.get("hub.verify_token") === verifyToken ? query.get("hub.challenge") : null;
}

/**
 * POST from Meta with delivery receipts. Returns the HTTP status to answer with.
 * 401 = bad signature (not from Meta), 400 = unreadable, 200 = handled. Answer 5xx only if saving failed, so Meta retries.
 */
export async function handleWebhook(rawBody: string, signature: string | null, appSecret: string, store: StatusStore): Promise<number> {
  if (!verifySignature(rawBody, signature, appSecret)) return 401;
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return 400;
  }
  try {
    for (const s of parseStatuses(payload)) {
      const error = s.errorTitle ? `${s.errorCode ?? ""} ${s.errorTitle}`.trim() : undefined;
      await store.applyStatus(s.messageId, s.status, error);
    }
  } catch {
    return 500;
  }
  return 200;
}
