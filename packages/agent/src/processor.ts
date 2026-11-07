import { HikvisionError, dayEnd, dayStart } from "@gym/hikvision";
import type { UpsertUserInput } from "@gym/hikvision";

export type JobAction = "upsert_user" | "delete_user" | "upload_face";

export interface DeviceJob {
  id: string;
  action: JobAction;
  payload: Record<string, unknown>;
  /** Already counts the current try (the claim increments it). */
  attempts: number;
}

/** Where jobs come from (the database). Outbound-only from the gym: the agent polls, nothing connects in. */
export interface JobStore {
  claim(limit: number): Promise<DeviceJob[]>;
  complete(id: string): Promise<void>;
  /** retryInSeconds: when to try again. permanent: stop trying and show the error in the dashboard. */
  fail(id: string, error: string, outcome: { retryInSeconds: number } | { permanent: true }): Promise<void>;
}

/** The part of HikvisionClient the agent needs. */
export interface DoorDevice {
  upsertUser(input: UpsertUserInput): Promise<{ created: boolean }>;
  deleteUser(employeeNo: string): Promise<void>;
  uploadFace(employeeNo: string, jpeg: Uint8Array): Promise<void>;
}

export interface FaceSource {
  download(path: string): Promise<Uint8Array>;
}

export interface ProcessSummary {
  done: number;
  retry: number;
  failed: number;
  /** True if we stopped early because the device rejected our login. */
  haltedOnBadLogin: boolean;
}

export const MAX_ATTEMPTS = 8;
const BAD_LOGIN_RETRY_SECONDS = 3600;

export function backoffSeconds(attempts: number): number {
  return Math.min(30 * 2 ** Math.max(0, attempts - 1), 3600);
}

function str(payload: Record<string, unknown>, key: string): string {
  const v = payload[key];
  if (typeof v !== "string" || v === "") throw new RangeError(`Job payload is missing "${key}"`);
  return v;
}

async function run(job: DeviceJob, device: DoorDevice, faces: FaceSource): Promise<void> {
  switch (job.action) {
    case "upsert_user":
      await device.upsertUser({
        employeeNo: str(job.payload, "employeeNo"),
        name: str(job.payload, "name"),
        beginTime: dayStart(str(job.payload, "beginDate")),
        endTime: dayEnd(str(job.payload, "endDate")),
      });
      return;
    case "delete_user":
      await device.deleteUser(str(job.payload, "employeeNo"));
      return;
    case "upload_face":
      await device.uploadFace(str(job.payload, "employeeNo"), await faces.download(str(job.payload, "facePath")));
      return;
    default:
      throw new RangeError(`Unknown job action "${String(job.action)}"`);
  }
}

/**
 * Claim a batch of jobs and apply them to the door device.
 *
 *  - Bad payload (RangeError)       -> failed for good, shown in the dashboard.
 *  - Wrong device login (HTTP 401)  -> STOP the whole batch and wait an hour. Hikvision locks the
 *                                      admin account after a few bad logins; hammering it makes it worse.
 *  - Device unreachable / other     -> retry with backoff, give up after MAX_ATTEMPTS.
 */
export async function processJobs(store: JobStore, device: DoorDevice, faces: FaceSource, batchSize = 20): Promise<ProcessSummary> {
  const summary: ProcessSummary = { done: 0, retry: 0, failed: 0, haltedOnBadLogin: false };
  const jobs = await store.claim(batchSize);

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    try {
      await run(job, device, faces);
      await store.complete(job.id);
      summary.done += 1;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);

      if (e instanceof HikvisionError && e.status === 401) {
        await store.fail(job.id, message, { retryInSeconds: BAD_LOGIN_RETRY_SECONDS });
        summary.retry += 1;
        // Put the untouched rest of the batch back too, without burning their attempts.
        for (const rest of jobs.slice(i + 1)) {
          await store.fail(rest.id, "Skipped: device login failed", { retryInSeconds: BAD_LOGIN_RETRY_SECONDS });
          summary.retry += 1;
        }
        summary.haltedOnBadLogin = true;
        return summary;
      }

      if (e instanceof RangeError || job.attempts >= MAX_ATTEMPTS) {
        await store.fail(job.id, message, { permanent: true });
        summary.failed += 1;
      } else {
        await store.fail(job.id, message, { retryInSeconds: backoffSeconds(job.attempts) });
        summary.retry += 1;
      }
    }
  }
  return summary;
}
