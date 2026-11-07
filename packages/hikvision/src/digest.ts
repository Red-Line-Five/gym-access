import { createHash, randomBytes } from "node:crypto";

const md5 = (s: string): string => createHash("md5").update(s).digest("hex");

export interface Challenge {
  realm: string;
  nonce: string;
  opaque?: string;
  qop?: "auth";
  algorithm?: string;
  stale: boolean;
}

/** Parse a `WWW-Authenticate: Digest ...` header. Returns null if it is not a Digest challenge. */
export function parseChallenge(header: string): Challenge | null {
  const at = header.search(/Digest\s/i);
  if (at < 0) return null;
  const rest = header.slice(at).replace(/^Digest\s+/i, "");
  const params: Record<string, string> = {};
  for (const m of rest.matchAll(/([a-zA-Z]+)=(?:"([^"]*)"|([^\s,]+))/g)) {
    params[m[1].toLowerCase()] = m[2] ?? m[3] ?? "";
  }
  if (!params.realm || !params.nonce) return null;
  const qops = (params.qop ?? "").split(",").map((q) => q.trim());
  const challenge: Challenge = {
    realm: params.realm,
    nonce: params.nonce,
    stale: (params.stale ?? "").toLowerCase() === "true",
  };
  if (params.opaque) challenge.opaque = params.opaque;
  if (qops.includes("auth")) challenge.qop = "auth";
  if (params.algorithm) challenge.algorithm = params.algorithm;
  return challenge;
}

/** Holds the current Digest challenge and signs requests with it (RFC 7616, MD5). */
export class DigestSession {
  private readonly username: string;
  private readonly password: string;
  private challenge: Challenge | null = null;
  private nc = 0;

  constructor(username: string, password: string) {
    this.username = username;
    this.password = password;
  }

  setChallenge(challenge: Challenge): void {
    this.challenge = challenge;
    this.nc = 0;
  }

  /** Authorization header value for this request, or null if we have no challenge yet. */
  authorize(method: string, uri: string): string | null {
    const c = this.challenge;
    if (!c) return null;
    this.nc += 1;
    const nc = this.nc.toString(16).padStart(8, "0");
    const cnonce = randomBytes(8).toString("hex");

    let ha1 = md5(`${this.username}:${c.realm}:${this.password}`);
    if (c.algorithm?.toUpperCase() === "MD5-SESS") ha1 = md5(`${ha1}:${c.nonce}:${cnonce}`);
    const ha2 = md5(`${method.toUpperCase()}:${uri}`);
    const response =
      c.qop === "auth"
        ? md5(`${ha1}:${c.nonce}:${nc}:${cnonce}:auth:${ha2}`)
        : md5(`${ha1}:${c.nonce}:${ha2}`);

    const parts = [
      `username="${this.username}"`,
      `realm="${c.realm}"`,
      `nonce="${c.nonce}"`,
      `uri="${uri}"`,
    ];
    if (c.algorithm) parts.push(`algorithm=${c.algorithm}`);
    if (c.qop === "auth") parts.push("qop=auth", `nc=${nc}`, `cnonce="${cnonce}"`);
    parts.push(`response="${response}"`);
    if (c.opaque) parts.push(`opaque="${c.opaque}"`);
    return `Digest ${parts.join(", ")}`;
  }
}
