import { WhatsAppError } from "@gym/whatsapp";
import type { TemplateName } from "@gym/whatsapp";

export interface QueuedMessage {
  id: string;
  kind: string;
  phone: string;
  /** [member name, gym name, date] */
  params: string[];
  /** Already counts the current try (the claim increments it). */
  attempts: number;
}

export interface MessageStore {
  claim(limit: number): Promise<QueuedMessage[]>;
  markSent(id: string, waMessageId: string): Promise<void>;
  /** retryInSeconds: try again later. permanent: stop and show the error in the Messages screen. */
  fail(id: string, error: string, outcome: { retryInSeconds: number } | { permanent: true }): Promise<void>;
}

export interface Sender {
  sendTemplate(to: string, template: TemplateName, params: string[]): Promise<{ messageId: string }>;
}

export interface SendSummary {
  sent: number;
  retry: number;
  failed: number;
  /** True if Meta rejected our token, so we stopped instead of failing every message. */
  haltedOnBadToken: boolean;
}

export const MAX_ATTEMPTS = 5;
const BAD_TOKEN_RETRY_SECONDS = 900;
const KINDS = new Set(["payment_received", "subscription_expiring", "gym_closed"]);

export function backoffSeconds(attempts: number): number {
  return Math.min(60 * 2 ** Math.max(0, attempts - 1), 3600);
}

/**
 * Meta error codes that will never succeed on retry. The member needs a different phone, or the
 * template needs fixing in WhatsApp Manager; either way a person has to look at it.
 *   131026 number is not on WhatsApp      131030 number not allowed (test mode)
 *   132000/132001/132012/132015/132016 template missing, wrong variables, paused or disabled
 *   131047/131049 re-engagement / ecosystem limits   100 invalid parameter
 */
const PERMANENT_CODES = new Set([100, 131026, 131030, 131047, 131049, 132000, 132001, 132012, 132015, 132016]);

export async function processMessages(store: MessageStore, wa: Sender, batchSize = 20): Promise<SendSummary> {
  const summary: SendSummary = { sent: 0, retry: 0, failed: 0, haltedOnBadToken: false };
  const batch = await store.claim(batchSize);

  for (let i = 0; i < batch.length; i++) {
    const m = batch[i];
    let messageId: string;
    try {
      if (!KINDS.has(m.kind)) throw new RangeError(`Unknown message kind "${m.kind}"`);
      ({ messageId } = await wa.sendTemplate(m.phone, m.kind as TemplateName, m.params));
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);

      // Wrong or expired token: every message would fail. Put the rest back and wait.
      if (e instanceof WhatsAppError && (e.status === 401 || e.code === 190)) {
        for (const rest of batch.slice(i)) {
          await store.fail(rest.id, rest.id === m.id ? text : "Skipped: WhatsApp token rejected", { retryInSeconds: BAD_TOKEN_RETRY_SECONDS });
          summary.retry += 1;
        }
        summary.haltedOnBadToken = true;
        return summary;
      }

      const permanent =
        e instanceof RangeError || (e instanceof WhatsAppError && e.code !== undefined && PERMANENT_CODES.has(e.code)) || m.attempts >= MAX_ATTEMPTS;
      if (permanent) {
        await store.fail(m.id, text, { permanent: true });
        summary.failed += 1;
      } else {
        await store.fail(m.id, text, { retryInSeconds: backoffSeconds(m.attempts) });
        summary.retry += 1;
      }
      continue;
    }

    // The message IS sent. Saving that fact is retried: if it still fails we would send a duplicate next round.
    let saved = false;
    for (let t = 0; t < 3 && !saved; t++) {
      try {
        await store.markSent(m.id, messageId);
        saved = true;
      } catch {
        await new Promise((r) => setTimeout(r, 200 * (t + 1)));
      }
    }
    if (!saved) throw new Error(`Message ${m.id} was sent (${messageId}) but could not be saved; stopping so it is not sent twice`);
    summary.sent += 1;
  }
  return summary;
}
