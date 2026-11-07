import { normalizePhone } from "./phone.ts";
import { TEMPLATES } from "./templates.ts";
import type { TemplateName } from "./templates.ts";

export interface WhatsAppConfig {
  /** The "Phone number ID" from WhatsApp Manager (not the phone number itself). */
  phoneNumberId: string;
  /** Permanent access token of a System User. Keep it in env/secret storage, never in git. */
  accessToken: string;
  apiVersion?: string;
  baseUrl?: string;
  /** Retries for 429 / 5xx / network errors. Default 2. */
  retries?: number;
  retryDelayMs?: number;
  fetch?: typeof fetch;
}

export class WhatsAppError extends Error {
  readonly status: number;
  /** Meta's error code, e.g. 132001 (template does not exist), 131030 (number not allowed in test mode). */
  readonly code: number | undefined;
  readonly retryable: boolean;

  constructor(message: string, status: number, code: number | undefined, retryable: boolean) {
    super(message);
    this.name = "WhatsAppError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export interface BroadcastRecipient {
  phone: string;
  params: string[];
}

export type BroadcastResult =
  | { phone: string; ok: true; messageId: string }
  | { phone: string; ok: false; error: string; code?: number };

/** Template variables may not contain newlines/tabs or runs of spaces, and may not be empty. */
export function cleanParam(value: string): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (!cleaned) throw new RangeError("Template parameter is empty");
  return cleaned;
}

export class WhatsAppClient {
  private readonly cfg: Required<Omit<WhatsAppConfig, "fetch">> & { fetch: typeof fetch };

  constructor(config: WhatsAppConfig) {
    this.cfg = {
      apiVersion: "v21.0",
      baseUrl: "https://graph.facebook.com",
      retries: 2,
      retryDelayMs: 500,
      ...config,
      fetch: config.fetch ?? fetch,
    };
  }

  async sendTemplate(
    to: string,
    template: TemplateName,
    params: string[],
    options: { language?: string } = {},
  ): Promise<{ messageId: string }> {
    const def = TEMPLATES[template];
    if (params.length !== def.params.length) {
      throw new RangeError(`Template "${template}" needs ${def.params.length} parameters (${def.params.join(", ")}), got ${params.length}`);
    }
    const body = JSON.stringify({
      messaging_product: "whatsapp",
      to: normalizePhone(to),
      type: "template",
      template: {
        name: template,
        language: { code: options.language ?? def.language },
        components: [{ type: "body", parameters: params.map((p) => ({ type: "text", text: cleanParam(p) })) }],
      },
    });
    return this.post(body);
  }

  /** Same template to many people. One failure never stops the rest. */
  async broadcast(
    template: TemplateName,
    recipients: BroadcastRecipient[],
    options: { concurrency?: number; language?: string } = {},
  ): Promise<BroadcastResult[]> {
    // Several members can share one phone (parent paying for kids): send once per number.
    const seen = new Set<string>();
    const unique: BroadcastRecipient[] = [];
    const results: BroadcastResult[] = [];
    for (const r of recipients) {
      let key: string;
      try {
        key = normalizePhone(r.phone);
      } catch (e) {
        results.push({ phone: r.phone, ok: false, error: e instanceof Error ? e.message : String(e) });
        continue;
      }
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(r);
    }

    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < unique.length) {
        const r = unique[next++];
        try {
          const { messageId } = await this.sendTemplate(r.phone, template, r.params, options);
          results.push({ phone: r.phone, ok: true, messageId });
        } catch (e) {
          const code = e instanceof WhatsAppError ? e.code : undefined;
          results.push({
            phone: r.phone,
            ok: false,
            error: e instanceof Error ? e.message : String(e),
            ...(code !== undefined ? { code } : {}),
          });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 5) }, worker));
    return results;
  }

  private async post(body: string): Promise<{ messageId: string }> {
    const url = `${this.cfg.baseUrl}/${this.cfg.apiVersion}/${this.cfg.phoneNumberId}/messages`;
    let lastError: WhatsAppError | undefined;

    for (let attempt = 0; attempt <= this.cfg.retries; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, this.cfg.retryDelayMs * attempt));
      try {
        const res = await this.cfg.fetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.cfg.accessToken}`, "Content-Type": "application/json" },
          body,
          signal: AbortSignal.timeout(15_000),
        });
        const text = await res.text();
        let json: { messages?: Array<{ id: string }>; error?: { message?: string; code?: number } } = {};
        try {
          json = JSON.parse(text);
        } catch {
          // non-JSON body (proxy error page): handled below via status
        }
        if (res.ok && json.messages?.[0]?.id) return { messageId: json.messages[0].id };

        const retryable = res.status === 429 || res.status >= 500;
        lastError = new WhatsAppError(
          json.error?.message ?? `WhatsApp API returned HTTP ${res.status}`,
          res.status,
          json.error?.code,
          retryable,
        );
        if (!retryable) throw lastError;
      } catch (e) {
        if (e instanceof WhatsAppError) {
          if (!e.retryable) throw e;
          lastError = e;
        } else {
          lastError = new WhatsAppError(`Network error: ${e instanceof Error ? e.message : String(e)}`, 0, undefined, true);
        }
      }
    }
    throw lastError ?? new WhatsAppError("Unknown WhatsApp error", 0, undefined, false);
  }
}
