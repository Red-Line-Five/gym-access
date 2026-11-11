import { WhatsAppClient } from "@gym/whatsapp";
import { processMessages } from "./processor.ts";
import { SupabaseMessageStore } from "./supabase.ts";

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing environment variable ${name} (see .env.example)`);
    process.exit(1);
  }
  return v;
}

const wa = new WhatsAppClient({ phoneNumberId: need("WA_PHONE_NUMBER_ID"), accessToken: need("WA_TOKEN") });
const store = new SupabaseMessageStore({ url: need("SUPABASE_URL"), serviceKey: need("SUPABASE_SERVICE_KEY"), gymId: need("GYM_ID") });
const pollMs = Number(process.env.POLL_SECONDS ?? "10") * 1000;

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => (stopping = true));

console.log(`gym-access WhatsApp sender started (gym ${process.env.GYM_ID})`);
while (!stopping) {
  try {
    const s = await processMessages(store, wa);
    if (s.sent + s.retry + s.failed > 0) console.log(new Date().toISOString(), JSON.stringify(s));
    if (s.haltedOnBadToken) console.error("WhatsApp rejected our token (expired or wrong). Check WA_TOKEN. Pausing 15 minutes for these messages.");
  } catch (e) {
    console.error(new Date().toISOString(), e instanceof Error ? e.message : e);
  }
  await new Promise((r) => setTimeout(r, pollMs));
}
console.log("sender stopped");
