import type { MessageStore, QueuedMessage } from "./processor.ts";
import type { StatusStore } from "./webhook.ts";

export interface SupabaseOptions {
  url: string;
  /** service_role key: bypasses RLS. Server only, never in a browser. */
  serviceKey: string;
  gymId: string;
  fetch?: typeof fetch;
}

export class SupabaseMessageStore implements MessageStore, StatusStore {
  private readonly o: Required<Omit<SupabaseOptions, "fetch">> & { fetch: typeof fetch };

  constructor(options: SupabaseOptions) {
    this.o = { ...options, fetch: options.fetch ?? fetch };
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { apikey: this.o.serviceKey, Authorization: `Bearer ${this.o.serviceKey}`, "Content-Type": "application/json", ...extra };
  }

  private async rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const res = await this.o.fetch(`${this.o.url}/rest/v1/rpc/${name}`, { method: "POST", headers: this.headers(), body: JSON.stringify(args) });
    if (!res.ok) throw new Error(`${name} failed: HTTP ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  async claim(limit: number): Promise<QueuedMessage[]> {
    const rows = await this.rpc<Array<{ id: string; kind: string; phone: string; params: string[]; attempts: number }>>("claim_notifications", { p_gym: this.o.gymId, p_limit: limit });
    return rows.map((r) => ({ id: r.id, kind: r.kind, phone: r.phone, params: r.params, attempts: r.attempts }));
  }

  async markSent(id: string, waMessageId: string): Promise<void> {
    // Not downgrading: a delivery receipt may already have arrived and moved the row to 'delivered'.
    await this.patch(`id=eq.${encodeURIComponent(id)}&status=eq.pending`, { status: "sent", wa_message_id: waMessageId, error: null, locked_at: null });
  }

  async fail(id: string, error: string, outcome: { retryInSeconds: number } | { permanent: true }): Promise<void> {
    if ("permanent" in outcome) {
      await this.patch(`id=eq.${encodeURIComponent(id)}`, { status: "failed", error, locked_at: null });
    } else {
      const runAfter = new Date(Date.now() + outcome.retryInSeconds * 1000).toISOString();
      await this.patch(`id=eq.${encodeURIComponent(id)}`, { status: "pending", error, run_after: runAfter, locked_at: null });
    }
  }

  async applyStatus(waMessageId: string, status: string, error?: string): Promise<void> {
    await this.rpc<number>("apply_message_status", { p_wa_message_id: waMessageId, p_status: status, p_error: error ?? null });
  }

  private async patch(filter: string, fields: Record<string, unknown>): Promise<void> {
    const res = await this.o.fetch(`${this.o.url}/rest/v1/notifications?${filter}`, {
      method: "PATCH", headers: this.headers({ Prefer: "return=minimal" }), body: JSON.stringify(fields),
    });
    if (!res.ok) throw new Error(`Updating notification failed: HTTP ${res.status} ${await res.text()}`);
  }
}
