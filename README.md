# gym-access

Gym membership app where the **door is the product**: a Hikvision face terminal opens only for members whose subscription is active, and members get WhatsApp messages when they pay and before they expire.

```
 Staff (browser)                 Supabase (cloud)                    Gym (local PC)
┌──────────────┐  payment      ┌──────────────────────┐  poll    ┌────────────────────┐   ISAPI    ┌───────────────┐
│ web app      │ ────────────▶ │ members, payments    │ ◀─────── │ agent (this repo)  │ ─────────▶ │ Hikvision     │
│ (next step)  │               │ device_jobs  (queue) │  claim   │ packages/agent     │  LAN only  │ face terminal │
└──────────────┘               │ notifications        │          └────────────────────┘            └───────────────┘
                               └──────────┬───────────┘
                                          │ cron: reminders, closed days
                                          ▼
                                 WhatsApp Cloud API  ──▶  member's phone
```

Why it is built this way:

- **The cloud cannot reach the door** (it sits behind the gym's router). So an **agent at the gym polls the database** (outbound only: no port forwarding, no VPN) and applies changes to the device.
- **The door enforces the subscription itself.** Every member is stored on the device with a `Valid` begin/end time. When someone pays, the agent moves the end date. If the internet or the server is down, the door still opens for paid members and still refuses expired ones.
- **Nothing is sent twice.** `notifications` has a unique key per member, message type and subscription period.

## What is in the box

| Package | What it does | Tests |
|---|---|---|
| `packages/hikvision` | ISAPI client: Digest login, create/update/delete member with validity dates, face upload, door events | 12 |
| `packages/whatsapp` | Cloud API sender for the 3 templates, Lebanese number normalizer, retries, broadcast, webhook signature check + delivery statuses | 10 |
| `packages/core` | Subscription math (early renewal keeps days, month-end clamping, gym timezone), who gets a reminder today, closed-day extensions | 12 |
| `packages/agent` | The loop at the gym: claims jobs, applies them to the door, backoff, stops on a bad device login | 6 |
| `supabase/schema.sql` | Tables, RLS, queue triggers, `claim_device_jobs`, `apply_closure` | 10 (on real PostgreSQL via PGlite) |

```bash
npm install
npm run typecheck
npm test        # 50 tests
```

Needs Node 22.18+ (it runs the TypeScript directly, no build step).

## What is proven and what is NOT yet

**Proven by the tests:** the logic, the database rules and security, the HTTP/Digest/multipart/retry behaviour against fakes.

**Not proven until you run the two smoke tests below:** the real Hikvision device and the real Meta account. The Hikvision tests run against a fake device that I wrote from the ISAPI documentation I know, so a model with slightly different endpoints would pass the tests and still fail at the gym. That is exactly what the smoke test is for, and it is the first thing to do.

## 1. Test the real door (at the gym)

On a PC on the same network as the terminal:

```bash
HIK_URL=http://192.168.1.64 HIK_USER=admin HIK_PASS='...' \
HIK_FACE=./my-face.jpg \
npm run smoke:hikvision
```

It creates a test member valid until tomorrow, renews it, uploads your photo, reads the door events, waits for you to try the door, then deletes the member. Every step prints `OK` or the device's own error. If a step fails, send me the output.

Before running it:

- Give the terminal a **fixed IP**.
- Make sure the **ISAPI / HTTP integration is enabled** and the account is allowed to manage persons (on many models: Network → Advanced → Integration Protocol; check your model's manual).
- Use a face photo that is a **JPEG under 200 KB**, front-facing, good light.
- Do not retry with a wrong password: Hikvision locks the account after a few failed logins. The client and the agent stop after one rejected login for this reason.

## 2. Test WhatsApp

1. In Meta Business: create a WhatsApp Business Account, add a phone number, and create a **System User** with a **permanent token** (permissions `whatsapp_business_messaging`, `whatsapp_business_management`). Note the **Phone number ID**.
2. In WhatsApp Manager create these 3 **templates** (category *Utility*, language *Arabic*), with the exact names and 3 variables each. Texts are in `packages/whatsapp/src/templates.ts`:
   - `payment_received`
   - `subscription_expiring`
   - `gym_closed`

   Approval usually takes minutes to a day. Business-initiated messages **must** use an approved template.
3. Send one message:

```bash
WA_PHONE_NUMBER_ID=123456789 WA_TOKEN='EAAG...' \
npm run smoke:whatsapp -- 03123456 payment_received
```

Failures print Meta's error code and what it usually means (template missing, wrong variable count, number not allowed in test mode, expired token). "Accepted" is not "delivered": delivery results come on the webhook (`verifySignature` + `parseStatuses` are ready for it).

Costs: Meta charges per template conversation; check the current Lebanon rate card before you set your price.

## 3. Run the agent at the gym

1. Create a Supabase project, run `supabase/schema.sql` in the SQL editor, create a private storage bucket `faces`.
2. Insert the gym row and its staff (see the top of `supabase/test/schema.test.ts` for the shape).
3. Copy `.env.example` to `.env`, fill it in, then on the gym PC:

```bash
node --env-file=.env packages/agent/src/main.ts
```

Run it as a Windows service (e.g. with NSSM) or a systemd unit so it starts with the PC. The service role key lives only on this machine.

## Business rules (in `packages/core`)

- Paying while active starts the new period the **day after** the current end (no lost days). Paying after expiry starts on the payment date.
- The end date is **inclusive**: 1 month from 07/11 ends 06/12 at 23:59:59.
- Reminder: 2 days before the end date, once per period. It uses a window (`end <= today + 2`), so a missed cron run still sends it the next day.
- Closed day: one action sends `gym_closed` to every member, and can extend everyone covered by that day by N days (`apply_closure`).
- Dates are the **gym's** calendar dates (`Asia/Beirut` by default), never the server's.

## Roadmap

1. Run both smoke tests on the real hardware and fix what they find.
2. Web app (Next.js + Supabase): staff login, members list, Excel import, "paid" button, webcam capture for the face photo, closed-day button.
3. Cron jobs: expiry reminders and the payment message, using `dueForExpiryReminder` and the `notifications` table.
4. Webhook endpoint for WhatsApp delivery status.
5. Pilot gym, then billing for the gyms themselves.

## Security notes

- `.env`, tokens and the service key are never committed (`.gitignore`).
- Members' phones and face photos are personal data: keep the `faces` bucket private and tell gyms what you store.
- RLS keeps each gym's staff inside their own gym; staff cannot write the device queue or call `claim_device_jobs`.


## Try the staff app on your PC (demo mode)

Needs Node 22.18 or newer. No account, no database to install.

```
npm install
npm run web
```

Open http://localhost:3000, pick **Reception** or **Owner**. The demo runs the real `supabase/schema.sql`
on a local Postgres (PGlite) and keeps its data in `apps/web/.data`. Delete that folder to start fresh.
Screens: Members, Record payment (price, discount, credit), Move credit, Import from Excel, Payments report
(+ download for Excel), Closed days (message everyone, optionally extend), Messages (the WhatsApp queue), Settings (owner only).

Not wired yet in the app: the door sync agent and WhatsApp sending (their code and tests are in `packages/`),
and real login (Supabase Auth).
