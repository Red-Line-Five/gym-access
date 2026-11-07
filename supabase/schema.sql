-- gym-access schema (Supabase / PostgreSQL)
-- Multi-tenant: every row belongs to a gym, and staff only see their own gym (RLS).
-- The agent (at the gym) and the cron jobs use the service_role key, which bypasses RLS.

-- ---------------------------------------------------------------- tables

create table gyms (
  id                       uuid primary key default gen_random_uuid(),
  name                     text not null,
  timezone                 text not null default 'Asia/Beirut',
  whatsapp_phone_number_id text,
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
  created_at   timestamptz not null default now(),
  check (period_end >= period_start)
);
create index payments_member_idx on payments (member_id, period_end desc);

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

-- ----------------------------------------------------------------- views

-- Each member's current end date and whether they are active today (in the GYM's timezone).
create view member_status with (security_invoker = true) as
select m.id, m.gym_id, m.full_name, m.phone, m.employee_no,
       max(p.period_end) as end_date,
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

create policy gyms_staff on gyms for select using (is_gym_staff(id));
create policy staff_self on staff for select using (user_id = auth.uid());
create policy members_staff on members for all using (is_gym_staff(gym_id)) with check (is_gym_staff(gym_id));
create policy payments_staff on payments for all using (is_gym_staff(gym_id)) with check (is_gym_staff(gym_id));
create policy jobs_staff_read on device_jobs for select using (is_gym_staff(gym_id));
create policy notifications_staff_read on notifications for select using (is_gym_staff(gym_id));
create policy closures_staff on closures for all using (is_gym_staff(gym_id)) with check (is_gym_staff(gym_id));

-- Only the agent (service_role) may claim jobs. Supabase grants execute to anon/authenticated by default, so revoke explicitly.
revoke execute on function claim_device_jobs(uuid, integer) from public, anon, authenticated;
grant execute on function claim_device_jobs(uuid, integer) to service_role;
