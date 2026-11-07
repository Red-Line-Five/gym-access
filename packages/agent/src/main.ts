import { HikvisionClient } from "@gym/hikvision";
import { processJobs } from "./processor.ts";
import { SupabaseJobStore } from "./supabase.ts";

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing environment variable ${name} (see .env.example)`);
    process.exit(1);
  }
  return v;
}

const device = new HikvisionClient({
  baseUrl: need("HIK_URL"),
  username: need("HIK_USER"),
  password: need("HIK_PASS"),
});
const store = new SupabaseJobStore({
  url: need("SUPABASE_URL"),
  serviceKey: need("SUPABASE_SERVICE_KEY"),
  gymId: need("GYM_ID"),
});
const pollMs = Number(process.env.POLL_SECONDS ?? "5") * 1000;

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => (stopping = true));

console.log(`gym-access agent started (gym ${process.env.GYM_ID}, device ${process.env.HIK_URL})`);
while (!stopping) {
  try {
    const s = await processJobs(store, device, store);
    if (s.done + s.retry + s.failed > 0) console.log(new Date().toISOString(), JSON.stringify(s));
    if (s.haltedOnBadLogin) console.error("Device rejected our login. Check HIK_USER / HIK_PASS. Pausing 1 hour for this job set.");
  } catch (e) {
    // Database/network problem: log it and try again on the next tick.
    console.error(new Date().toISOString(), e instanceof Error ? e.message : e);
  }
  await new Promise((r) => setTimeout(r, pollMs));
}
console.log("agent stopped");
