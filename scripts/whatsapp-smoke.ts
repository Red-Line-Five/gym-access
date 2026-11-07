/**
 * Send ONE real template message to prove WhatsApp works end to end:
 *
 *   WA_PHONE_NUMBER_ID=123456789 WA_TOKEN=EAAG... npm run smoke:whatsapp -- 03123456 payment_received
 *
 * Arguments: <phone> [payment_received | subscription_expiring | gym_closed]
 * Before Meta approves your business, the recipient must be added to the "To" list in
 * WhatsApp Manager > API Setup (test numbers only).
 */
import { TEMPLATES, WhatsAppClient, WhatsAppError } from "@gym/whatsapp";
import type { TemplateName } from "@gym/whatsapp";

const [phone, templateArg = "payment_received"] = process.argv.slice(2);
if (!phone || !(templateArg in TEMPLATES)) {
  console.error(`Usage: npm run smoke:whatsapp -- <phone> [${Object.keys(TEMPLATES).join(" | ")}]`);
  process.exit(1);
}
for (const name of ["WA_PHONE_NUMBER_ID", "WA_TOKEN"]) {
  if (!process.env[name]) {
    console.error(`Set ${name} first (see README, "Test WhatsApp").`);
    process.exit(1);
  }
}

const template = templateArg as TemplateName;
const client = new WhatsAppClient({
  phoneNumberId: process.env.WA_PHONE_NUMBER_ID as string,
  accessToken: process.env.WA_TOKEN as string,
});

try {
  const { messageId } = await client.sendTemplate(phone, template, ["Test Member", "Test Gym", "06/12/2026"]);
  console.log(`OK    Meta accepted the message (${messageId}). Check the phone.`);
  console.log("      Accepted is not delivered: delivery results arrive later on your webhook.");
} catch (e) {
  if (e instanceof WhatsAppError) {
    console.error(`FAIL  ${e.message} (HTTP ${e.status}, code ${e.code ?? "-"})`);
    const hints: Record<number, string> = {
      132001: 'Template not found: create it with this exact name and language "ar" in WhatsApp Manager, and wait for approval.',
      132000: "Wrong number of variables: the approved template must have exactly 3 ({{1}} {{2}} {{3}}).",
      131030: "Recipient not in the allowed list: add the number under API Setup > To (test mode).",
      190: "Access token expired or invalid: create a permanent System User token.",
    };
    if (e.code !== undefined && hints[e.code]) console.error(`      ${hints[e.code]}`);
  } else {
    console.error(`FAIL  ${e instanceof Error ? e.message : e}`);
  }
  process.exit(1);
}
