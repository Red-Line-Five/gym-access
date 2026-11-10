-- gym-access schema (Supabase / PostgreSQL)
-- Multi-tenant: every row belongs to a gym, and staff only see their own gym (RLS).
-- The agent (at the gym) and the cron jobs use the service_role key, which bypasses RLS.

-- ---------------------------------------------------------------- tables

create table gyms (
  id                       uuid primary key default gen_random_uuid(),
  name                     text not null,
  timezone                 text not null default 'Asia/Beirut',
  whatsapp_phone_number_id text,
  price_usd                numeric(10, 2) not null default 60 check (price_usd > 0),   -- one month
  lbp_rate                 integer not null default 90000 check (lbp_rate > 0),         -- LL for $1
  created_at               timestamptz not null default now()
);

create table staff (
  user_id uuid not null,                       -- auth.users.id
  gym_id  uuid not null references gyms(id) on delete cascade,
  role    text not null default 'employee' check (role in ('owner', 'employee')),
  primary key (user_id, gym_id)
);

create table members (
  id          uuid primary key default gen_random_uuid(),
  gym_id      uuid not null references gyms(id) on delete cascade,
  full_name   text not null,
  phone       text,
  -- The member's number on the door device. Digits only, unique per gym.
  employee_no integer not null default 0,
  face_path   text,                            -- path in the "faces" storage bucket
  created_at  timestamptz not null default now(),
  unique (gym_id, employee_no)
);

-- One row per payment. A closure extension is a payment of 0 with kind = 'extension'.
create table payments (
  id           uuid primary key default gen_random_uuid(),
  gym_id       uuid not null references gyms(id) on delete cascade,
  member_id    uuid not null references members(id) on delete cascade,
  kind         text not null default 'payment' check (kind in ('payment', 'extension')),
  amount       numeric(12, 2) not null default 0 check (amount >= 0),
  currency     text not null default 'USD' check (currency in ('USD', 'LBP')),
  paid_on      date not null,
  period_start date not null,
  period_end   date not null,                  -- INCLUSIVE last day of access
  recorded_by  uuid,                           -- the employee (auth.users.id)
  -- Snapshot of the money side, so changing the price or rate later never rewrites history.
  -- amount/currency = what the client actually handed over.
  list_price_usd  numeric(12, 2),              -- price of the months bought, at the time
  credit_used_usd numeric(12, 2) not null default 0,
  discount_usd    numeric(12, 2) not null default 0,   -- list price minus (cash + credit), when the employee charged less
  lbp_rate        integer,                     -- LL per $1 at the time
  created_at   timestamptz not null default now(),
  check (period_end >= period_start)
);
create index payments_member_idx on payments (member_id, period_end desc);

-- Credit kept on a member (gift, advance, overpayment). Signed USD ledger: balance = sum(amount_usd).
create table credit_entries (
  id          uuid primary key default gen_random_uuid(),
  gym_id      uuid not null references gyms(id) on delete cascade,
  member_id   uuid not null references members(id) on delete cascade,
  amount_usd  numeric(12, 2) not null check (amount_usd <> 0),
  kind        text not null check (kind in ('deposit', 'used', 'transfer_in', 'transfer_out')),
  payment_id  uuid references payments(id) on delete set null,
  transfer_id uuid,                            -- same value on both sides of a transfer
  note        text,
  recorded_by uuid,
  created_at  timestamptz not null default now()
);
create index credit_entries_member_idx on credit_entries (member_id);

-- Work for the door device. The agent at the gym claims these (outbound polling only).
create table device_jobs (
  id         uuid primary key default gen_random_uuid(),
  seq        bigint generated always as identity,   -- strict creation order (created_at can tie inside one transaction)
  gym_id     uuid not null references gyms(id) on delete cascade,
  member_id  uuid references members(id) on delete set null,
  action     text not null check (action in ('upsert_user', 'delete_user', 'upload_face')),
  payload    jsonb not null,
  status     text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed')),
  attempts   integer not null default 0,
  run_after  timestamptz not null default now(),
  locked_at  timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);
create index device_jobs_queue_idx on device_jobs (gym_id, status, run_after);

-- Every WhatsApp message we decide to send. The unique key makes it impossible to send twice.
create table notifications (
  id            uuid primary key default gen_random_uuid(),
  gym_id        uuid not null references gyms(id) on delete cascade,
  member_id     uuid not null references members(id) on delete cascade,
  kind          text not null check (kind in ('payment_received', 'subscription_expiring', 'gym_closed')),
  period_key    text not null,                 -- payment: period_end, expiring: period_end, closed: the closed date
  status        text not null default 'pending' check (status in ('pending', 'sent', 'delivered', 'read', 'failed')),
  phone         text not null,                 -- snapshot at the time we decided to send
  params        jsonb not null,                -- the 3 template variables: [member name, gym name, date]
  wa_message_id text,
  error         text,
  created_at    timestamptz not null default now(),
  unique (member_id, kind, period_key)
);

-- A day the gym is closed. Staff press one button; we message everyone, and optionally extend.
create table closures (
  id          uuid primary key default gen_random_uuid(),
  gym_id      uuid not null references gyms(id) on delete cascade,
  closed_on   date not null,
  reason      text,
  extend_days integer not null default 0 check (extend_days between 0 and 7),
  created_by  uuid,
  created_at  timestamptz not null default now(),
  unique (gym_id, closed_on)
);

-- ------------------------------------------------------------- functions

create or replace function is_gym_staff(g uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from staff s where s.gym_id = g and s.user_id = auth.uid());
$$;

-- employee_no: next free number in the gym, unless one is given.
create or replace function members_set_employee_no() returns trigger
language plpgsql as $$
begin
  if new.employee_no is null or new.employee_no = 0 then
    select coalesce(max(employee_no), 0) + 1 into new.employee_no from members where gym_id = new.gym_id;
  end if;
  return new;
end $$;

create trigger members_employee_no before insert on members
  for each row execute function members_set_employee_no();

-- A payment (or extension) changes what the door should allow: queue a sync job.
-- The door's "valid from" is the member's FIRST period start, so renewing early never locks them out.
create or replace function payments_enqueue_door_sync() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into device_jobs (gym_id, member_id, action, payload)
  select m.gym_id, m.id, 'upsert_user',
         jsonb_build_object(
           'employeeNo', m.employee_no::text,
           'name',       m.full_name,
           'beginDate',  (select min(p.period_start) from payments p where p.member_id = m.id),
           'endDate',    (select max(p.period_end)   from payments p where p.member_id = m.id)
         )
  from members m where m.id = new.member_id;
  return new;
end $$;

create trigger payments_door_sync after insert on payments
  for each row execute function payments_enqueue_door_sync();

-- A new face photo: queue the upload (the member must be on the device first; the agent retries).
create or replace function members_enqueue_face() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.face_path is not null and new.face_path is distinct from old.face_path then
    insert into device_jobs (gym_id, member_id, action, payload)
    values (new.gym_id, new.id, 'upload_face',
            jsonb_build_object('employeeNo', new.employee_no::text, 'facePath', new.face_path));
  end if;
  return new;
end $$;

create trigger members_face_sync after update of face_path on members
  for each row execute function members_enqueue_face();

-- Removing a member removes them from the door. Their id is gone by then, so the payload carries the number.
create or replace function members_enqueue_delete() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into device_jobs (gym_id, member_id, action, payload)
  values (old.gym_id, null, 'delete_user', jsonb_build_object('employeeNo', old.employee_no::text));
  return old;
end $$;

create trigger members_door_delete before delete on members
  for each row execute function members_enqueue_delete();

-- The agent claims work atomically. `skip locked` means two agents never take the same job,
-- and a job stuck in 'running' for 5 minutes (agent crashed) is handed out again.
--
-- ORDER MATTERS per member (employeeNo): a job is only handed out when no OLDER job for the same
-- member is still pending/running. Otherwise a retried old job could land after a newer one and put
-- a stale end date on the door. It also makes a face upload wait for its member's create job.
create or replace function claim_device_jobs(p_gym uuid, p_limit integer default 20)
returns setof device_jobs language sql as $$
  update device_jobs d
     set status = 'running', attempts = d.attempts + 1, locked_at = now()
   where d.id in (
     select j.id from device_jobs j
      where j.gym_id = p_gym
        and j.run_after <= now()
        and (j.status = 'pending' or (j.status = 'running' and j.locked_at < now() - interval '5 minutes'))
        and not exists (
          select 1 from device_jobs older
           where older.gym_id = j.gym_id
             and older.payload->>'employeeNo' = j.payload->>'employeeNo'
             and older.seq < j.seq
             and older.status in ('pending', 'running')
        )
      order by j.seq
      limit p_limit
      for update skip locked
   )
  returning d.*;
$$;

-- Everyone whose subscription covers `p_closed_on` gets `p_days` extra days. Returns how many.
create or replace function apply_closure(p_gym uuid, p_closed_on date, p_days integer) returns integer
language plpgsql as $$
declare n integer;
begin
  if p_days < 1 then
    return 0;
  end if;
  with ins as (
    insert into payments (gym_id, member_id, kind, amount, paid_on, period_start, period_end)
    select s.gym_id, s.id, 'extension', 0, p_closed_on, s.end_date + 1, s.end_date + p_days
      from member_status s
     where s.gym_id = p_gym and s.end_date >= p_closed_on
    returning 1
  )
  select count(*) into n from ins;
  return n;
end $$;

-- ------------------------------------------------------ messages & closures

-- Receipt: every real payment queues the "payment received" WhatsApp (not closure extensions).
create or replace function payments_queue_receipt() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into notifications (gym_id, member_id, kind, period_key, phone, params)
  select m.gym_id, m.id, 'payment_received', new.period_end::text, m.phone,
         jsonb_build_array(m.full_name, g.name, to_char(new.period_end, 'DD/MM/YYYY'))
    from members m join gyms g on g.id = m.gym_id
   where m.id = new.member_id and coalesce(btrim(m.phone), '') <> ''
  on conflict do nothing;
  return new;
end $$;

create trigger payments_receipt after insert on payments
  for each row when (new.kind = 'payment') execute function payments_queue_receipt();

-- Reminder: everyone whose subscription ends within p_days (today included), once per period.
-- Safe to run as often as you like (the unique key stops duplicates), and a missed day is caught up the next day.
-- Staff may call it, and so may the scheduled job (service_role has no auth.uid()).
create or replace function queue_expiry_reminders(p_gym uuid, p_days integer default 2) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer; v_today date;
begin
  if auth.uid() is not null and not is_gym_staff(p_gym) then raise exception 'not allowed'; end if;
  select (now() at time zone timezone)::date into v_today from gyms where id = p_gym;
  with ins as (
    insert into notifications (gym_id, member_id, kind, period_key, phone, params)
    select s.gym_id, s.id, 'subscription_expiring', s.end_date::text, s.phone,
           jsonb_build_array(s.full_name, g.name, to_char(s.end_date, 'DD/MM/YYYY'))
      from member_status s join gyms g on g.id = s.gym_id
     where s.gym_id = p_gym and coalesce(btrim(s.phone), '') <> ''
       and s.end_date between v_today and v_today + p_days
    on conflict do nothing
    returning 1)
  select count(*) into n from ins;
  return n;
end $$;

-- "Gym closed" button: record the closed day, message EVERY member with a phone, and optionally give
-- everyone whose subscription covers that day extra days. Returns {notified, extended}.
create or replace function close_gym(p_gym uuid, p_closed_on date, p_reason text default null, p_extend_days integer default 0)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_extended integer := 0; v_notified integer;
begin
  if not is_gym_staff(p_gym) then raise exception 'not allowed'; end if;
  if p_extend_days < 0 or p_extend_days > 7 then raise exception 'extend days must be 0 to 7'; end if;
  if exists (select 1 from closures where gym_id = p_gym and closed_on = p_closed_on) then
    raise exception 'this day is already marked as closed';
  end if;
  insert into closures (gym_id, closed_on, reason, extend_days, created_by)
  values (p_gym, p_closed_on, nullif(btrim(p_reason), ''), p_extend_days, auth.uid());
  if p_extend_days > 0 then v_extended := apply_closure(p_gym, p_closed_on, p_extend_days); end if;
  with ins as (
    insert into notifications (gym_id, member_id, kind, period_key, phone, params)
    select m.gym_id, m.id, 'gym_closed', p_closed_on::text, m.phone,
           jsonb_build_array(m.full_name, g.name, to_char(p_closed_on, 'DD/MM/YYYY'))
      from members m join gyms g on g.id = m.gym_id
     where m.gym_id = p_gym and coalesce(btrim(m.phone), '') <> ''
    on conflict do nothing
    returning 1)
  select count(*) into v_notified from ins;
  return jsonb_build_object('notified', v_notified, 'extended', v_extended);
end $$;

revoke execute on function queue_expiry_reminders(uuid, integer), close_gym(uuid, date, text, integer) from public, anon;

-- ------------------------------------------------------- money functions
-- Staff call these (not raw inserts). They check the caller belongs to the gym, lock the member row so two
-- employees cannot spend the same credit, and write payment + ledger in one transaction.

create or replace function credit_balance(p_member uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(amount_usd), 0) from credit_entries where member_id = p_member and is_gym_staff(gym_id);
$$;

-- Subscription payment. Cash is whatever the employee typed (default: the amount due).
--   received > due  -> the extra becomes credit      received < due -> recorded as a discount (full months still given)
create or replace function record_payment(
  p_member uuid, p_months integer, p_received numeric, p_currency text default 'USD',
  p_use_credit boolean default true, p_paid_on date default null
) returns payments
language plpgsql security definer set search_path = public as $$
declare
  m members; g gyms;
  v_paid_on date; v_end date; v_start date;
  v_balance numeric; v_price numeric; v_applied numeric; v_due numeric; v_received_usd numeric; v_diff numeric;
  v_discount numeric := 0; v_pay payments;
begin
  select * into m from members where id = p_member for update;
  if not found or not is_gym_staff(m.gym_id) then raise exception 'not allowed'; end if;
  if p_months < 1 or p_months > 24 then raise exception 'months must be 1 to 24'; end if;
  if p_received is null or p_received < 0 then raise exception 'received must be 0 or more'; end if;
  if p_currency not in ('USD', 'LBP') then raise exception 'currency must be USD or LBP'; end if;
  select * into g from gyms where id = m.gym_id;

  v_paid_on := coalesce(p_paid_on, (now() at time zone g.timezone)::date);
  select coalesce(sum(amount_usd), 0) into v_balance from credit_entries where member_id = m.id;
  v_price := g.price_usd * p_months;
  v_applied := case when p_use_credit then least(v_balance, v_price) else 0 end;
  v_due := v_price - v_applied;
  v_received_usd := round(case when p_currency = 'USD' then p_received else p_received / g.lbp_rate end, 2);
  v_diff := v_received_usd - v_due;

  -- Early renewal starts the day after the current end; otherwise today. Same rule as core nextPeriod().
  select max(period_end) into v_end from payments where member_id = m.id;
  v_start := case when v_end is not null and v_end >= v_paid_on then v_end + 1 else v_paid_on end;
  if v_diff < -0.005 then v_discount := -v_diff; end if;

  insert into payments (gym_id, member_id, amount, currency, paid_on, period_start, period_end, recorded_by,
                        list_price_usd, credit_used_usd, discount_usd, lbp_rate)
  values (m.gym_id, m.id, p_received, p_currency, v_paid_on, v_start,
          ((v_start + make_interval(months => p_months))::date - 1), auth.uid(),
          v_price, v_applied, v_discount, g.lbp_rate)
  returning * into v_pay;

  if v_applied > 0 then
    insert into credit_entries (gym_id, member_id, amount_usd, kind, payment_id, recorded_by)
    values (m.gym_id, m.id, -v_applied, 'used', v_pay.id, auth.uid());
  end if;
  if v_diff >= 0.01 then
    insert into credit_entries (gym_id, member_id, amount_usd, kind, payment_id, recorded_by)
    values (m.gym_id, m.id, v_diff, 'deposit', v_pay.id, auth.uid());
  end if;
  return v_pay;
end $$;

-- Owner changes the gym's price and rate. Employees cannot (gyms has no update policy).
create or replace function set_gym_pricing(p_gym uuid, p_price numeric, p_rate integer) returns gyms
language plpgsql security definer set search_path = public as $$
declare g gyms;
begin
  if not exists (select 1 from staff where gym_id = p_gym and user_id = auth.uid() and role = 'owner') then
    raise exception 'only the owner can change prices';
  end if;
  update gyms set price_usd = p_price, lbp_rate = p_rate where id = p_gym returning * into g;
  return g;
end $$;

-- Gift / advance: money kept on the member, no subscription change.
create or replace function keep_credit(p_member uuid, p_amount numeric, p_currency text default 'USD', p_note text default null)
returns credit_entries
language plpgsql security definer set search_path = public as $$
declare m members; g gyms; v_usd numeric; e credit_entries;
begin
  select * into m from members where id = p_member for update;
  if not found or not is_gym_staff(m.gym_id) then raise exception 'not allowed'; end if;
  if p_currency not in ('USD', 'LBP') then raise exception 'currency must be USD or LBP'; end if;
  select * into g from gyms where id = m.gym_id;
  v_usd := round(case when p_currency = 'USD' then p_amount else p_amount / g.lbp_rate end, 2);
  if v_usd < 0.01 then raise exception 'amount must be above zero'; end if;
  insert into credit_entries (gym_id, member_id, amount_usd, kind, note, recorded_by)
  values (m.gym_id, m.id, v_usd, 'deposit', p_note, auth.uid()) returning * into e;
  return e;
end $$;

-- Move credit between two members of the same gym. Both rows are locked in id order (no deadlocks).
create or replace function transfer_credit(p_from uuid, p_to uuid, p_amount numeric, p_note text default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare a members; b members; v_balance numeric; v_id uuid := gen_random_uuid();
begin
  if p_from = p_to then raise exception 'choose a different member'; end if;
  if p_amount is null or p_amount < 0.01 then raise exception 'amount must be above zero'; end if;
  perform 1 from members where id in (p_from, p_to) order by id for update;
  select * into a from members where id = p_from;
  select * into b from members where id = p_to;
  if a.id is null or b.id is null or a.gym_id <> b.gym_id or not is_gym_staff(a.gym_id) then raise exception 'not allowed'; end if;
  select coalesce(sum(amount_usd), 0) into v_balance from credit_entries where member_id = a.id;
  if p_amount > v_balance then raise exception 'only % of credit available', v_balance; end if;
  insert into credit_entries (gym_id, member_id, amount_usd, kind, transfer_id, note, recorded_by) values
    (a.gym_id, a.id, -round(p_amount, 2), 'transfer_out', v_id, p_note, auth.uid()),
    (a.gym_id, b.id,  round(p_amount, 2), 'transfer_in',  v_id, p_note, auth.uid());
  return v_id;
end $$;

revoke execute on function set_gym_pricing(uuid, numeric, integer), credit_balance(uuid), record_payment(uuid, integer, numeric, text, boolean, date),
  keep_credit(uuid, numeric, text, text), transfer_credit(uuid, uuid, numeric, text) from public, anon;

-- ----------------------------------------------------------------- views

-- Each member's current end date and whether they are active today (in the GYM's timezone).
create view member_status with (security_invoker = true) as
select m.id, m.gym_id, m.full_name, m.phone, m.employee_no,
       max(p.period_end) as end_date,
       (select coalesce(sum(c.amount_usd), 0) from credit_entries c where c.member_id = m.id) as credit_usd,
       coalesce(max(p.period_end) >= (now() at time zone g.timezone)::date, false) as active
  from members m
  join gyms g on g.id = m.gym_id
  left join payments p on p.member_id = m.id
 group by m.id, g.timezone;

-- -------------------------------------------------------------- security

alter table gyms          enable row level security;
alter table staff         enable row level security;
alter table members       enable row level security;
alter table payments      enable row level security;
alter table device_jobs   enable row level security;
alter table notifications enable row level security;
alter table closures      enable row level security;
alter table credit_entries enable row level security;

create policy gyms_staff on gyms for select using (is_gym_staff(id));
create policy staff_self on staff for select using (user_id = auth.uid());
create policy members_staff on members for all using (is_gym_staff(gym_id)) with check (is_gym_staff(gym_id));
create policy payments_staff on payments for all using (is_gym_staff(gym_id)) with check (is_gym_staff(gym_id));
create policy jobs_staff_read on device_jobs for select using (is_gym_staff(gym_id));
create policy notifications_staff_read on notifications for select using (is_gym_staff(gym_id));
create policy credit_staff_read on credit_entries for select using (is_gym_staff(gym_id));
create policy closures_staff on closures for all using (is_gym_staff(gym_id)) with check (is_gym_staff(gym_id));

-- Only the agent (service_role) may claim jobs. Supabase grants execute to anon/authenticated by default, so revoke explicitly.
revoke execute on function claim_device_jobs(uuid, integer) from public, anon, authenticated;
grant execute on function claim_device_jobs(uuid, integer) to service_role;
