import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

const md5 = (s: string): string => createHash("md5").update(s).digest("hex");

export interface MockUser {
  employeeNo: string;
  name: string;
  Valid: { enable: boolean; beginTime: string; endTime: string; timeType: string };
  [key: string]: unknown;
}

export interface MockDeviceOptions {
  username?: string;
  password?: string;
  /** After this many authenticated requests, invalidate the nonce (answers 401 stale=true). */
  rotateNonceAfter?: number;
  events?: Array<{ employeeNo: string; name: string; time: string }>;
  eventPageSize?: number;
}

/** A tiny fake of a Hikvision access terminal's ISAPI, with real Digest authentication. */
export class MockDevice {
  readonly users = new Map<string, MockUser>();
  readonly faces = new Map<string, Buffer>();
  readonly paths: string[] = [];
  challenges = 0;
  url = "";

  private readonly username: string;
  private readonly password: string;
  private readonly realm = "DS-K1T343MFWX";
  private nonce = randomBytes(8).toString("hex");
  private authedCount = 0;
  private readonly options: MockDeviceOptions;
  private server: Server | null = null;

  constructor(options: MockDeviceOptions = {}) {
    this.options = options;
    this.username = options.username ?? "admin";
    this.password = options.password ?? "secret123";
  }

  static async start(options: MockDeviceOptions = {}): Promise<MockDevice> {
    const device = new MockDevice(options);
    device.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => device.handle(req, res, Buffer.concat(chunks)));
    });
    await new Promise<void>((resolve) => device.server!.listen(0, "127.0.0.1", resolve));
    device.url = `http://127.0.0.1:${(device.server!.address() as AddressInfo).port}`;
    return device;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server?.closeAllConnections();
      this.server?.close(() => resolve());
    });
  }

  private challenge(res: ServerResponse, stale: boolean): void {
    this.challenges += 1;
    res.writeHead(401, {
      "WWW-Authenticate": `Digest realm="${this.realm}", qop="auth", nonce="${this.nonce}", opaque="${md5("opaque")}"${stale ? ", stale=true" : ""}`,
      "Content-Type": "text/plain",
    });
    res.end("Unauthorized");
  }

  private authenticate(req: IncomingMessage): "ok" | "none" | "stale" | "bad" {
    const header = req.headers.authorization;
    if (!header?.startsWith("Digest ")) return "none";
    const p: Record<string, string> = {};
    for (const m of header.slice(7).matchAll(/(\w+)=(?:"([^"]*)"|([^\s,]+))/g)) p[m[1]] = m[2] ?? m[3];
    if (p.username !== this.username || p.uri !== req.url) return "bad";
    if (p.nonce !== this.nonce) return "stale";
    const ha1 = md5(`${p.username}:${this.realm}:${this.password}`);
    const ha2 = md5(`${req.method}:${p.uri}`);
    const expected = md5(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`);
    return expected === p.response ? "ok" : "bad";
  }

  private handle(req: IncomingMessage, res: ServerResponse, body: Buffer): void {
    const auth = this.authenticate(req);
    if (auth === "none") return this.challenge(res, false);
    if (auth === "stale") return this.challenge(res, true);
    if (auth === "bad") return this.challenge(res, false);

    this.authedCount += 1;
    if (this.options.rotateNonceAfter && this.authedCount % this.options.rotateNonceAfter === 0) {
      this.nonce = randomBytes(8).toString("hex");
    }

    const url = new URL(req.url ?? "/", "http://device");
    this.paths.push(`${req.method} ${url.pathname}`);
    const json = (status: number, obj: unknown): void => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const ok = (): void => json(200, { statusCode: 1, statusString: "OK", subStatusCode: "ok" });
    const fail = (sub: string): void =>
      json(400, { statusCode: 4, statusString: "Invalid Operation", subStatusCode: sub, errorCode: 1073741825 });

    switch (`${req.method} ${url.pathname}`) {
      case "GET /ISAPI/System/deviceInfo":
        res.writeHead(200, { "Content-Type": "application/xml" });
        res.end(
          `<?xml version="1.0" encoding="UTF-8"?><DeviceInfo version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema"><deviceName>Gym door</deviceName><model>DS-K1T343MFWX</model><serialNumber>DS-K1T343MFWX20240101AAWRG12345678</serialNumber></DeviceInfo>`,
        );
        return;

      case "POST /ISAPI/AccessControl/UserInfo/Record": {
        const u = (JSON.parse(body.toString()) as { UserInfo: MockUser }).UserInfo;
        if (this.users.has(u.employeeNo)) return fail("employeeNoAlreadyExist");
        this.users.set(u.employeeNo, u);
        return ok();
      }

      case "PUT /ISAPI/AccessControl/UserInfo/Modify": {
        const u = (JSON.parse(body.toString()) as { UserInfo: MockUser }).UserInfo;
        if (!this.users.has(u.employeeNo)) return fail("employeeNoNotExist");
        this.users.set(u.employeeNo, u);
        return ok();
      }

      case "PUT /ISAPI/AccessControl/UserInfo/Delete": {
        const cond = JSON.parse(body.toString()) as {
          UserInfoDelCond: { EmployeeNoList: Array<{ employeeNo: string }> };
        };
        for (const e of cond.UserInfoDelCond.EmployeeNoList) {
          this.users.delete(e.employeeNo);
          this.faces.delete(e.employeeNo);
        }
        return ok();
      }

      case "POST /ISAPI/Intelligent/FDLib/FaceDataRecord": {
        const boundary = /boundary=(.+)$/.exec(String(req.headers["content-type"]))?.[1];
        if (!boundary) return fail("badContentType");
        const parts = parseMultipart(body, boundary);
        const record = parts.find((p) => p.name === "FaceDataRecord");
        const image = parts.find((p) => p.name === "FaceImage");
        if (!record || !image) return fail("missingPart");
        const fpid = (JSON.parse(record.data.toString()) as { FPID: string }).FPID;
        if (!this.users.has(fpid)) return fail("employeeNoNotExist");
        this.faces.set(fpid, image.data);
        return ok();
      }

      case "POST /ISAPI/AccessControl/AcsEvent": {
        const cond = (JSON.parse(body.toString()) as {
          AcsEventCond: { searchResultPosition: number; maxResults: number };
        }).AcsEventCond;
        const all = this.options.events ?? [];
        const size = Math.min(cond.maxResults, this.options.eventPageSize ?? cond.maxResults);
        const slice = all.slice(cond.searchResultPosition, cond.searchResultPosition + size);
        const more = cond.searchResultPosition + slice.length < all.length;
        return json(200, {
          AcsEvent: {
            searchID: "gym-access",
            totalMatches: all.length,
            responseStatusStrg: more ? "MORE" : "OK",
            numOfMatches: slice.length,
            InfoList: slice.map((e) => ({
              major: 5,
              minor: 75,
              time: e.time,
              name: e.name,
              employeeNoString: e.employeeNo,
            })),
          },
        });
      }

      default:
        res.writeHead(404);
        res.end("not found");
    }
  }
}

function parseMultipart(body: Buffer, boundary: string): Array<{ name: string; data: Buffer }> {
  const delimiter = Buffer.from(`--${boundary}`);
  const out: Array<{ name: string; data: Buffer }> = [];
  let pos = body.indexOf(delimiter);
  while (pos >= 0) {
    const next = body.indexOf(delimiter, pos + delimiter.length);
    if (next < 0) break;
    const part = body.subarray(pos + delimiter.length + 2, next - 2); // strip CRLF after/before delimiters
    const headerEnd = part.indexOf("\r\n\r\n");
    const headers = part.subarray(0, headerEnd).toString();
    const name = /name="([^"]+)"/.exec(headers)?.[1] ?? "";
    out.push({ name, data: part.subarray(headerEnd + 4) });
    pos = next;
  }
  return out;
}
