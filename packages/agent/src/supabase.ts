import type { DeviceJob, FaceSource, JobStore } from "./processor.ts";

export interface SupabaseOptions {
  /** https://<project>.supabase.co */
  url: string;
  /** The service_role key. It bypasses RLS: keep it only on the gym PC / server, never in a browser. */
  serviceKey: string;
  gymId: string;
  /** Storage bucket that holds the face photos. */
  faceBucket?: string;
  fetch?: typeof fetch;
}

/** Talks to Supabase's REST API directly (no SDK needed). */
export class SupabaseJobStore implements JobStore, FaceSource {
  private readonly o: Required<Omit<SupabaseOptions, "fetch">> & { fetch: typeof fetch };

  constructor(options: SupabaseOptions) {
    this.o = { faceBucket: "faces", ...options, fetch: options.fetch ?? fetch };
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      apikey: this.o.serviceKey,
      Authorization: `Bearer ${this.o.serviceKey}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  async claim(limit: number): Promise<DeviceJob[]> {
    const res = await this.o.fetch(`${this.o.url}/rest/v1/rpc/claim_device_jobs`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ p_gym: this.o.gymId, p_limit: limit }),
    });
    if (!res.ok) throw new Error(`claim_device_jobs failed: HTTP ${res.status} ${await res.text()}`);
    const rows = (await res.json()) as Array<{ id: string; action: DeviceJob["action"]; payload: Record<string, unknown>; attempts: number }>;
    return rows.map((r) => ({ id: r.id, action: r.action, payload: r.payload, attempts: r.attempts }));
  }

  async complete(id: string): Promise<void> {
    await this.patch(id, { status: "done", last_error: null });
  }

  async fail(id: string, error: string, outcome: { retryInSeconds: number } | { permanent: true }): Promise<void> {
    if ("permanent" in outcome) {
      await this.patch(id, { status: "failed", last_error: error });
    } else {
      const runAfter = new Date(Date.now() + outcome.retryInSeconds * 1000).toISOString();
      await this.patch(id, { status: "pending", run_after: runAfter, last_error: error });
    }
  }

  async download(path: string): Promise<Uint8Array> {
    const res = await this.o.fetch(`${this.o.url}/storage/v1/object/${this.o.faceBucket}/${path}`, {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`Could not download face "${path}": HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  private async patch(id: string, fields: Record<string, unknown>): Promise<void> {
    const res = await this.o.fetch(`${this.o.url}/rest/v1/device_jobs?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: this.headers({ Prefer: "return=minimal" }),
      body: JSON.stringify(fields),
    });
    if (!res.ok) throw new Error(`Updating job ${id} failed: HTTP ${res.status} ${await res.text()}`);
  }
}
