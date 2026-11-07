import { randomBytes } from "node:crypto";
import { DigestSession, parseChallenge } from "./digest.ts";
import { HikvisionError } from "./errors.ts";
import { DEVICE_TIME_RE } from "./time.ts";

export interface HikvisionOptions {
  /** e.g. "http://192.168.1.64" (no trailing path) */
  baseUrl: string;
  username: string;
  password: string;
  timeoutMs?: number;
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

export interface UpsertUserInput {
  /** Digits only, max 32. This is the member's number on the device. */
  employeeNo: string;
  name: string;
  /** Device local time, YYYY-MM-DDTHH:mm:ss */
  beginTime: string;
  /** Device local time, YYYY-MM-DDTHH:mm:ss. After this the door refuses the member. */
  endTime: string;
  doorNo?: number;
  planTemplateNo?: string;
}

export interface DeviceInfo {
  model: string;
  serialNumber: string;
  deviceName: string;
  raw: string;
}

export interface AccessEvent {
  employeeNo: string;
  name: string;
  /** As returned by the device, usually with a UTC offset. */
  time: string;
  major: number;
  minor: number;
}

export interface AccessEventQuery {
  /** e.g. "2026-11-07T00:00:00+02:00" */
  startTime: string;
  endTime: string;
  pageSize?: number;
  /** Safety cap on how many events to return in total. */
  maxEvents?: number;
}

interface Reply {
  status: number;
  text: string;
}

const JSON_TYPE = "application/json";
const MAX_FACE_BYTES_DEFAULT = 200 * 1024;

/** The device stores names in a small fixed buffer (32 bytes). Cut on a character boundary. */
export function truncateUtf8(text: string, maxBytes: number): string {
  let out = "";
  let bytes = 0;
  for (const ch of text) {
    const n = Buffer.byteLength(ch, "utf8");
    if (bytes + n > maxBytes) break;
    out += ch;
    bytes += n;
  }
  return out;
}

function tryParse(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function xmlTag(xml: string, tag: string): string {
  return new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)?.[1] ?? "";
}

export class HikvisionClient {
  private readonly baseUrl: string;
  private readonly digest: DigestSession;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: HikvisionOptions) {
    this.baseUrl = options.baseUrl;
    this.digest = new DigestSession(options.username, options.password);
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchFn = options.fetch ?? fetch;
  }

  async deviceInfo(): Promise<DeviceInfo> {
    const res = await this.send("GET", "/ISAPI/System/deviceInfo");
    if (res.status >= 400) throw new HikvisionError(`deviceInfo failed (HTTP ${res.status})`, res.status, res.text);
    return {
      model: xmlTag(res.text, "model"),
      serialNumber: xmlTag(res.text, "serialNumber"),
      deviceName: xmlTag(res.text, "deviceName"),
      raw: res.text,
    };
  }

  /**
   * Create the member on the device, or update them if they already exist.
   * The device itself enforces beginTime/endTime, so the door keeps working
   * (and keeps refusing expired members) even if our server or the internet is down.
   */
  async upsertUser(input: UpsertUserInput): Promise<{ created: boolean }> {
    if (!/^\d{1,32}$/.test(input.employeeNo)) {
      throw new RangeError(`employeeNo must be 1-32 digits, got "${input.employeeNo}"`);
    }
    for (const t of [input.beginTime, input.endTime]) {
      if (!DEVICE_TIME_RE.test(t)) throw new RangeError(`Expected YYYY-MM-DDTHH:mm:ss, got "${t}"`);
    }
    if (input.beginTime > input.endTime) throw new RangeError("beginTime is after endTime");

    const body = JSON.stringify({
      UserInfo: {
        employeeNo: input.employeeNo,
        name: truncateUtf8(input.name, 32),
        userType: "normal",
        Valid: { enable: true, beginTime: input.beginTime, endTime: input.endTime, timeType: "local" },
        doorRight: String(input.doorNo ?? 1),
        RightPlan: [{ doorNo: input.doorNo ?? 1, planTemplateNo: input.planTemplateNo ?? "1" }],
      },
    });

    const created = await this.send("POST", "/ISAPI/AccessControl/UserInfo/Record?format=json", body, JSON_TYPE);
    const createdJson = tryParse(created.text);
    if (createdJson?.subStatusCode === "employeeNoAlreadyExist") {
      const modified = await this.send("PUT", "/ISAPI/AccessControl/UserInfo/Modify?format=json", body, JSON_TYPE);
      this.check(modified, "update user");
      return { created: false };
    }
    this.check(created, "create user");
    return { created: true };
  }

  async deleteUser(employeeNo: string): Promise<void> {
    if (!/^\d{1,32}$/.test(employeeNo)) throw new RangeError(`employeeNo must be 1-32 digits, got "${employeeNo}"`);
    const body = JSON.stringify({ UserInfoDelCond: { EmployeeNoList: [{ employeeNo }] } });
    const res = await this.send("PUT", "/ISAPI/AccessControl/UserInfo/Delete?format=json", body, JSON_TYPE);
    this.check(res, "delete user");
  }

  /**
   * Upload the member's face photo. The member must already exist on the device.
   * Device rules: JPEG, usually <= 200 KB. Resize on the server before calling this.
   */
  async uploadFace(employeeNo: string, jpeg: Uint8Array, maxBytes = MAX_FACE_BYTES_DEFAULT): Promise<void> {
    if (!/^\d{1,32}$/.test(employeeNo)) throw new RangeError(`employeeNo must be 1-32 digits, got "${employeeNo}"`);
    if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new RangeError("Face image must be a JPEG");
    if (jpeg.length > maxBytes) {
      throw new RangeError(`Face image is ${jpeg.length} bytes, the device accepts at most ${maxBytes}`);
    }

    const boundary = `----gymaccess${randomBytes(8).toString("hex")}`;
    const record = JSON.stringify({ faceLibType: "blackFD", FDID: "1", FPID: employeeNo });
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="FaceDataRecord"\r\nContent-Type: application/json\r\n\r\n${record}\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="FaceImage"; filename="face.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
      ),
      Buffer.from(jpeg),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const res = await this.send(
      "POST",
      "/ISAPI/Intelligent/FDLib/FaceDataRecord?format=json",
      body,
      `multipart/form-data; boundary=${boundary}`,
    );
    this.check(res, "upload face");
  }

  /** Successful face-recognition door events (check-ins), following the device's paging. */
  async getAccessEvents(query: AccessEventQuery): Promise<AccessEvent[]> {
    const pageSize = query.pageSize ?? 30;
    const maxEvents = query.maxEvents ?? 1000;
    const events: AccessEvent[] = [];
    let position = 0;

    while (events.length < maxEvents) {
      const body = JSON.stringify({
        AcsEventCond: {
          searchID: "gym-access",
          searchResultPosition: position,
          maxResults: pageSize,
          major: 5,
          minor: 75,
          startTime: query.startTime,
          endTime: query.endTime,
        },
      });
      const res = await this.send("POST", "/ISAPI/AccessControl/AcsEvent?format=json", body, JSON_TYPE);
      const json = this.check(res, "read access events");
      const acs = (json?.AcsEvent ?? {}) as { InfoList?: Array<Record<string, unknown>>; responseStatusStrg?: string };
      const list = acs.InfoList ?? [];
      for (const e of list) {
        events.push({
          employeeNo: String(e.employeeNoString ?? ""),
          name: String(e.name ?? ""),
          time: String(e.time ?? ""),
          major: Number(e.major ?? 0),
          minor: Number(e.minor ?? 0),
        });
      }
      position += list.length;
      if (acs.responseStatusStrg !== "MORE" || list.length === 0) break;
    }
    return events.slice(0, maxEvents);
  }

  /** Throws on HTTP errors and on the device's own non-OK statusCode. Returns the parsed JSON body. */
  private check(res: Reply, what: string): Record<string, unknown> | null {
    const json = tryParse(res.text);
    const code = json?.statusCode;
    if (res.status >= 400 || (typeof code === "number" && code !== 1)) {
      const sub = typeof json?.subStatusCode === "string" ? json.subStatusCode : undefined;
      const detail = sub ?? (typeof json?.statusString === "string" ? json.statusString : `HTTP ${res.status}`);
      throw new HikvisionError(`${what} failed: ${detail}`, res.status, res.text, sub);
    }
    return json;
  }

  private async send(method: string, path: string, body?: string | Buffer, contentType?: string): Promise<Reply> {
    const url = new URL(path, this.baseUrl);
    const uri = url.pathname + url.search;

    for (let attempt = 0; attempt < 3; attempt++) {
      const headers: Record<string, string> = { Accept: "application/json, application/xml" };
      if (contentType) headers["Content-Type"] = contentType;
      const auth = this.digest.authorize(method, uri);
      if (auth) headers.Authorization = auth;

      let res: Response;
      let text: string;
      try {
        res = await this.fetchFn(url, {
          method,
          headers,
          body: body as RequestInit["body"],
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        text = await res.text();
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new HikvisionError(`Cannot reach the device at ${this.baseUrl}: ${reason}`, 0, "");
      }

      if (res.status !== 401) return { status: res.status, text };

      const challenge = parseChallenge(res.headers.get("www-authenticate") ?? "");
      if (!challenge) throw new HikvisionError("The device did not offer Digest authentication", 401, text);
      this.digest.setChallenge(challenge);
      // We already sent credentials and the nonce was fine: the password is wrong. Stop.
      if (auth && !challenge.stale) throw new HikvisionError("Wrong username or password", 401, text);
    }
    throw new HikvisionError("Authentication did not complete", 401, "");
  }
}
