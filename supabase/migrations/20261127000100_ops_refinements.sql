-- =====================================================================
-- 0017  Ops Refinements
--   * Tenant: buffer_mins=5, therapist_daily_cap=40 (labella), gst_rate
--   * Bookings: midnight end (1470), ended_early_at/actual_end_min, gst_amt, client_code
--   * Memberships/Expenses: upi2 payment mode
--   * end_therapy RPC
--   * client_code_profiles table + lookup_client_by_code RPC
--   * Updated: staff_create_booking, reschedule_booking, update_booking_billing,
--              create_membership, bookings_th2_validate (actual_end_min-aware)
-- =====================================================================

-- ─────────────────────────────────────────────────────────────────────
-- Part 1: New columns on tenants
-- ─────────────────────────────────────────────────────────────────────
alter table public.tenants
  add column if not exists therapist_daily_cap integer,
  add column if not exists gst_rate numeric(5,2) not null default 0;

-- ─────────────────────────────────────────────────────────────────────
-- Part 2: Tenant data updates
-- ─────────────────────────────────────────────────────────────────────
update public.tenants set buffer_mins = 5
  where lower(name) in ('thalasso', 'labella');

update public.tenants set therapist_daily_cap = 40
  where lower(name) = 'labella';

update public.tenants set gst_rate = 5.00
  where lower(name) = 'labella';

update public.tenants set gst_rate = 0.00
  where lower(name) = 'thalasso';

-- ─────────────────────────────────────────────────────────────────────
-- Part 3: Bookings – midnight end_min, early-end columns, gst_amt, client_code
-- ─────────────────────────────────────────────────────────────────────
alter table public.bookings drop constraint if exists bookings_end_min_check;
alter table public.bookings drop constraint if exists bookings_end_min;
alter table public.bookings add constraint bookings_end_min_check
  check (end_min > 0 and end_min <= 1470);

alter table public.bookings
  add column ended_early_at timestamptz,
  add column actual_end_min integer
    check (actual_end_min is null or (actual_end_min > 0 and actual_end_min <= 1470)),
  add column gst_amt integer not null default 0,
  add column client_code text
    check (client_code is null or client_code ~ '^[0-9]{4}$');

-- ─────────────────────────────────────────────────────────────────────
-- Part 4: Payment constraints – add upi2
-- ─────────────────────────────────────────────────────────────────────
alter table public.bookings drop constraint if exists bookings_payment_method_check;
alter table public.bookings add constraint bookings_payment_method_check
  check (payment_method in ('pending','cash','card','upi','upi2','membership'));

alter table public.expenses drop constraint if exists expenses_payment_mode_check;
alter table public.expenses add constraint expenses_payment_mode_check
  check (payment_mode in ('cash','card','upi','upi2'));

alter table public.memberships drop constraint if exists memberships_payment_mode_check;
alter table public.memberships add constraint memberships_payment_mode_check
  check (payment_mode in ('cash','card','upi','upi2','legacy'));

alter table public.memberships
  add column client_code text
    check (client_code is null or client_code ~ '^[0-9]{4}$');

-- ─────────────────────────────────────────────────────────────────────
-- Part 5: GST trigger on bookings
-- ─────────────────────────────────────────────────────────────────────
create or replace function private.bookings_gst()
returns trigger language plpgsql security definer
set search_path = public, pg_temp as $$
declare v_rate numeric(5,2);
begin
  select gst_rate into v_rate from public.tenants where id = new.tenant_id;
  if new.payment_method in ('card','upi','upi2') then
    new.gst_amt := round(
      greatest(
        coalesce(new.price, 0) + coalesce(new.addon_amt, 0) - coalesce(new.discount_amt, 0),
        0
      ) * coalesce(v_rate, 0) / 100.0
    );
  else
    new.gst_amt := 0;
  end if;
  return new;
end $$;

create trigger bookings_gst_calc
  before insert or update of payment_method, price, addon_amt, discount_amt
  on public.bookings for each row execute function private.bookings_gst();

-- ─────────────────────────────────────────────────────────────────────
-- Part 6: client_code_profiles table
-- ─────────────────────────────────────────────────────────────────────
create table public.client_code_profiles (
  tenant_id    uuid        not null references public.tenants(id) on delete cascade,
  client_code  text        not null check (client_code ~ '^[0-9]{4}$'),
  profile_id   uuid        not null default gen_random_uuid(),
  client_name  text,
  phone        text,
  preferences  text        check (preferences is null or length(preferences) <= 500),
  updated_at   timestamptz not null default now(),
  updated_by   uuid        references auth.users(id) on delete set null,
  primary key  (tenant_id, client_code, profile_id)
);

create index ccp_tenant_code_idx on public.client_code_profiles (tenant_id, client_code);

alter table public.client_code_profiles enable row level security;
grant select, insert, update on public.client_code_profiles to authenticated;

create policy ccp_read on public.client_code_profiles
  for select to authenticated using (private.my_tenant() = tenant_id);

create policy ccp_insert on public.client_code_profiles
  for insert to authenticated with check (private.my_tenant() = tenant_id);

create policy ccp_update on public.client_code_profiles
  for update to authenticated
  using  (private.my_tenant() = tenant_id)
  with check (private.my_tenant() = tenant_id);

-- ─────────────────────────────────────────────────────────────────────
-- Part 7: Update bookings_th2_validate to respect actual_end_min
-- ─────────────────────────────────────────────────────────────────────
create or replace function private.bookings_th2_validate()
returns trigger language plpgsql security definer
set search_path = public, pg_temp as $$
begin
  if new.therapist_id_2 is null then return new; end if;
  if not exists (
    select 1 from public.therapists
     where id = new.therapist_id_2
       and branch_id = new.branch_id and tenant_id = new.tenant_id
  ) then
    raise exception 'therapist_id_2 must belong to the same branch as the booking'
      using errcode = 'TH001';
  end if;
  if new.status <> 'confirmed' or new.kind <> 'booking' then return new; end if;
  if exists (
    select 1 from public.bookings x
     where x.id <> new.id and x.date = new.date
       and x.kind = 'booking' and x.status = 'confirmed'
       and x.start_min < new.end_min
       and coalesce(x.actual_end_min, x.end_min) > new.start_min
       and (x.therapist_id = new.therapist_id_2 or x.therapist_id_2 = new.therapist_id_2)
  ) then
    raise exception 'therapist_id_2 is already booked at this time' using errcode = 'TH002';
  end if;
  if new.therapist_id is not null and exists (
    select 1 from public.bookings x
     where x.id <> new.id
       and x.therapist_id_2 = new.therapist_id and x.date = new.date
       and x.kind = 'booking' and x.status = 'confirmed'
       and x.start_min < new.end_min
       and coalesce(x.actual_end_min, x.end_min) > new.start_min
  ) then
    raise exception 'therapist_id is already a secondary on another booking at this time'
      using errcode = 'TH003';
  end if;
  return new;
end $$;

-- ─────────────────────────────────────────────────────────────────────
-- Part 8: end_therapy RPC
-- ─────────────────────────────────────────────────────────────────────
create or replace function public.end_therapy(p_booking_id uuid)
returns text language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  b         public.bookings%rowtype;
  v_now     timestamptz := now();
  v_tz      text;
  v_now_loc timestamptz;
  v_cur_min int;
  v_actual  int;
begin
  if auth.uid() is null then return 'forbidden'; end if;
  select * into b from public.bookings
   where id = p_booking_id and kind = 'booking' for update;
  if not found then return 'not_found'; end if;
  if not private.staff_ok(b.tenant_id, b.branch_id) then return 'forbidden'; end if;
  if b.status <> 'confirmed'       then return 'not_confirmed'; end if;
  if b.ended_early_at is not null  then return 'already_ended'; end if;

  select timezone into v_tz from public.tenants where id = b.tenant_id;
  v_now_loc := v_now at time zone coalesce(v_tz, 'Asia/Kolkata');
  v_cur_min := extract(hour  from v_now_loc)::int * 60
             + extract(minute from v_now_loc)::int;
  v_actual  := greatest(b.start_min + 1, least(v_cur_min, b.end_min));

  update public.bookings
     set ended_early_at = v_now,
         actual_end_min = v_actual
   where id = p_booking_id;

  return 'ok';
end $$;

-- ─────────────────────────────────────────────────────────────────────
-- Part 9: lookup_client_by_code RPC
-- ─────────────────────────────────────────────────────────────────────
create or replace function public.lookup_client_by_code(p_code text)
returns jsonb language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_tenant         uuid := private.my_tenant();
  v_profiles       jsonb;
  v_visit_count    bigint;
  v_last_date      date;
  v_last_treatment text;
  v_memberships    jsonb;
begin
  if auth.uid() is null or v_tenant is null then
    return jsonb_build_object('status','forbidden');
  end if;
  if p_code is null or p_code !~ '^[0-9]{4}$' then
    return jsonb_build_object('status','invalid_code');
  end if;
  select jsonb_agg(jsonb_build_object(
    'profile_id',  ccp.profile_id,
    'client_name', ccp.client_name,
    'phone',       ccp.phone,
    'preferences', ccp.preferences,
    'updated_at',  ccp.updated_at
  ) order by ccp.updated_at desc)
    into v_profiles
    from public.client_code_profiles ccp
   where ccp.tenant_id = v_tenant and ccp.client_code = p_code;
  select count(*), max(date)
    into v_visit_count, v_last_date
    from public.bookings
   where tenant_id = v_tenant and client_code = p_code
     and kind = 'booking' and status = 'confirmed';
  select service_name into v_last_treatment
    from public.bookings
   where tenant_id = v_tenant and client_code = p_code
     and kind = 'booking' and status = 'confirmed'
   order by date desc, start_min desc limit 1;
  select jsonb_agg(jsonb_build_object(
    'id',                 m.id,
    'kind',               m.kind,
    'code',               m.code,
    'branch_name',        br.name,
    'holder_name',        m.holder_name,
    'remaining_sessions', m.remaining_sessions,
    'total_sessions',     m.total_sessions,
    'expires_on',         m.expires_on,
    'amount_paid',        m.amount_paid,
    'payment_mode',       m.payment_mode
  ) order by m.created_at desc)
    into v_memberships
    from public.memberships m
    join public.branches br on br.id = m.branch_id
   where m.tenant_id = v_tenant and m.client_code = p_code and m.active = true;
  return jsonb_build_object(
    'status',          'ok',
    'client_code',     p_code,
    'profiles',        coalesce(v_profiles,    '[]'::jsonb),
    'visit_count',     coalesce(v_visit_count, 0),
    'last_visit_date', v_last_date,
    'last_treatment',  v_last_treatment,
    'memberships',     coalesce(v_memberships, '[]'::jsonb)
  );
end $$;

-- ─────────────────────────────────────────────────────────────────────
-- Part 10: Updated staff_create_booking (+ p_client_code, upi2, NA phone)
-- ─────────────────────────────────────────────────────────────────────
drop function if exists public.staff_create_booking(text,text,int,date,int,text,text,text,text,text,int,text,text,int,uuid,boolean,uuid);

create or replace function public.staff_create_booking(
  p_branch text, p_service text, p_duration int, p_date date, p_start int,
  p_name text, p_phone text,
  p_notes text default null, p_source text default 'phone',
  p_addon_text text default null, p_addon_amt int default 0,
  p_payment_method text default 'pending',
  p_discount_text text default null, p_discount_amt int default 0,
  p_therapist_id_2 uuid default null,
  p_therapist_requested boolean default false,
  p_membership_id uuid default null,
  p_client_code text default null
)
returns jsonb language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  t public.tenants%rowtype; b public.branches%rowtype;
  o record; m public.memberships%rowtype;
  v_tenant uuid := private.my_tenant();
  v_ref text; v_id uuid; v_who text;
  v_addon text := nullif(trim(coalesce(p_addon_text,'')), '');
  v_amt int := coalesce(p_addon_amt, 0);
  v_disc_text text := nullif(trim(coalesce(p_discount_text,'')), '');
  v_disc int := coalesce(p_discount_amt, 0);
  v_pm text := coalesce(p_payment_method, 'pending');
  v_mid uuid := p_membership_id;
  v_code text; v_end int;
begin
  if auth.uid() is null or v_tenant is null then return jsonb_build_object('status','forbidden'); end if;
  select * into t from public.tenants where id = v_tenant and active;
  if not found then return jsonb_build_object('status','invalid'); end if;
  select * into b from public.branches where tenant_id = v_tenant and code = p_branch and active;
  if not found then return jsonb_build_object('status','invalid'); end if;
  if not private.staff_ok(v_tenant, b.id) then return jsonb_build_object('status','forbidden'); end if;
  if p_name is null or length(trim(p_name)) < 2 then return jsonb_build_object('status','badname'); end if;
  if p_phone = 'NA' then
    if p_client_code is null or p_client_code !~ '^[0-9]{4}$' then
      return jsonb_build_object('status','badphone'); end if;
    v_code := p_client_code;
  elsif p_phone is null or p_phone !~ t.phone_pattern then
    return jsonb_build_object('status','badphone');
  else
    if p_phone ~ '^[0-9]{10}$' then v_code := right(p_phone, 4);
    elsif p_client_code ~ '^[0-9]{4}$' then v_code := p_client_code; end if;
  end if;
  if p_source not in ('phone','walkin') then return jsonb_build_object('status','invalid'); end if;
  if p_date is null or p_start is null then return jsonb_build_object('status','invalid'); end if;
  if v_amt < 0 or v_amt > 100000 or length(coalesce(v_addon,'')) > 80
     or (v_amt > 0 and v_addon is null)
  then return jsonb_build_object('status','badaddon'); end if;
  if v_pm not in ('pending','cash','card','upi','upi2','membership')
  then return jsonb_build_object('status','invalid'); end if;
  if v_disc < 0 or v_disc > 100000 then return jsonb_build_object('status','baddiscount'); end if;
  if v_pm = 'membership' then
    if v_mid is null then return jsonb_build_object('status','membership_required'); end if;
    select * into m from public.memberships where id = v_mid and tenant_id = v_tenant for update;
    if not found    then return jsonb_build_object('status','membership_not_found'); end if;
    if not m.active then return jsonb_build_object('status','membership_inactive'); end if;
    if m.remaining_sessions <= 0 then return jsonb_build_object('status','membership_exhausted'); end if;
    if m.expires_on is not null and m.expires_on < p_date then
      return jsonb_build_object('status','membership_expired'); end if;
  else v_mid := null; end if;
  select s.name as sname, so.price into o
    from public.services s join public.service_options so on so.service_id = s.id
   where s.menu_id = b.menu_id and s.code = p_service and s.active
     and so.duration_min = p_duration and so.active;
  if not found then return jsonb_build_object('status','invalid'); end if;
  if v_disc > o.price + v_amt then return jsonb_build_object('status','baddiscount'); end if;
  v_end := p_start + p_duration;
  if p_start < b.open_min or v_end > b.close_min then return jsonb_build_object('status','closed'); end if;
  v_ref := private.new_ref(t.id, t.ref_prefix);
  select u.email into v_who from auth.users u where u.id = auth.uid();
  delete from public.bookings where kind = 'hold' and expires_at < now();
  begin
    insert into public.bookings (
      tenant_id, branch_id, loc_id, loc_name, kind, status, ref,
      service_id, service_name, duration, price, date, start_min, end_min, room_no,
      name, phone, notes, source, created_by,
      addon_text, addon_amt, payment_method, discount_text, discount_amt,
      therapist_id_2, therapist_requested, membership_id, client_code
    ) values (
      t.id, b.id, b.code, b.name, 'booking', 'confirmed', v_ref,
      p_service, o.sname||' ('||p_duration||' Mins)', p_duration, o.price,
      p_date, p_start, v_end, null,
      left(trim(p_name),80), p_phone,
      left(coalesce(nullif(trim(p_notes),''),'None'),500),
      p_source, coalesce(v_who,'staff'),
      v_addon, v_amt, v_pm, v_disc_text, v_disc,
      p_therapist_id_2, coalesce(p_therapist_requested,false), v_mid, v_code
    ) returning id into v_id;
  exception
    when sqlstate 'CF001' then return jsonb_build_object('status','full');
    when sqlstate 'TH001' then return jsonb_build_object('status','th2_wrong_branch');
    when sqlstate 'TH002' then return jsonb_build_object('status','th2_busy');
    when sqlstate 'TH003' then return jsonb_build_object('status','th1_busy_as_secondary');
  end;
  if v_pm = 'membership' and v_mid is not null then
    update public.memberships set remaining_sessions = remaining_sessions - 1 where id = v_mid;
    insert into public.membership_ledger (tenant_id, membership_id, booking_id, sessions_delta, reason, created_by)
    values (v_tenant, v_mid, v_id, -1, 'booking '||v_ref, auth.uid());
  end if;
  return jsonb_build_object('status','ok','id',v_id,'ref',v_ref,'room',null);
end $$;

-- ─────────────────────────────────────────────────────────────────────
-- Part 11: Updated reschedule_booking (actual_end_min-aware, midnight ok)
-- ─────────────────────────────────────────────────────────────────────
create or replace function public.reschedule_booking(
  p_booking_id uuid, p_service_option_id uuid default null,
  p_date date default null, p_start_min int default null)
returns text language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  b public.bookings%rowtype; br public.branches%rowtype; o record;
  v_buf int; v_new_end int; v_who text;
  v_new_date date; v_new_start int;
  v_new_dur int; v_new_price int; v_new_sid text; v_new_sname text;
begin
  if auth.uid() is null then return 'no_booking'; end if;
  select * into b from public.bookings where id = p_booking_id and kind = 'booking' for update;
  if not found or not private.staff_ok(b.tenant_id, b.branch_id) then return 'no_booking'; end if;
  if b.status <> 'confirmed' then return 'not_confirmed'; end if;
  v_new_date  := coalesce(p_date, b.date);
  v_new_start := coalesce(p_start_min, b.start_min);
  if p_service_option_id is not null then
    select so.duration_min, so.price, s.code,
           s.name||' ('||so.duration_min||' Mins)' as sname into o
      from public.service_options so join public.services s on s.id = so.service_id
     where so.id = p_service_option_id
       and s.menu_id = (select menu_id from public.branches where id = b.branch_id)
       and s.active and so.active;
    if not found then return 'invalid'; end if;
    v_new_dur := o.duration_min; v_new_price := o.price;
    v_new_sid := o.code; v_new_sname := o.sname;
  else
    v_new_dur := b.duration; v_new_price := b.price;
    v_new_sid := b.service_id; v_new_sname := b.service_name;
  end if;
  if v_new_date = b.date and v_new_start = b.start_min
     and v_new_dur = b.duration and v_new_price = b.price then return 'no_change'; end if;
  v_new_end := v_new_start + v_new_dur;
  select * into br from public.branches where id = b.branch_id;
  if v_new_start < br.open_min or v_new_end > br.close_min then return 'closed'; end if;
  select buffer_mins into v_buf from public.tenants where id = b.tenant_id;
  if b.therapist_id is not null and exists (
    select 1 from public.bookings x where x.id <> b.id
      and x.therapist_id = b.therapist_id and x.date = v_new_date
      and x.kind = 'booking' and x.status = 'confirmed'
      and x.start_min < v_new_end
      and coalesce(x.actual_end_min, x.end_min) > v_new_start
  ) then return 'therapist_busy'; end if;
  if b.therapist_id_2 is not null and exists (
    select 1 from public.bookings x where x.id <> b.id
      and x.date = v_new_date and x.kind = 'booking' and x.status = 'confirmed'
      and x.start_min < v_new_end
      and coalesce(x.actual_end_min, x.end_min) > v_new_start
      and (x.therapist_id = b.therapist_id_2 or x.therapist_id_2 = b.therapist_id_2)
  ) then return 'th2_busy'; end if;
  if b.room_no is not null and exists (
    select 1 from public.bookings x where x.id <> b.id
      and x.branch_id = b.branch_id and x.date = v_new_date and x.room_no = b.room_no
      and x.status = 'confirmed'
      and x.start_min < v_new_end + v_buf
      and coalesce(x.actual_end_min, x.end_min) + v_buf > v_new_start
  ) then return 'room_busy'; end if;
  select u.email into v_who from auth.users u where u.id = auth.uid();
  update public.bookings set
    orig_date         = coalesce(orig_date,        b.date),
    orig_start_min    = coalesce(orig_start_min,   b.start_min),
    orig_service_id   = coalesce(orig_service_id,  b.service_id),
    orig_service_name = coalesce(orig_service_name,b.service_name),
    orig_duration     = coalesce(orig_duration,    b.duration),
    orig_price        = coalesce(orig_price,       b.price),
    date              = v_new_date, start_min = v_new_start, end_min = v_new_end,
    duration          = v_new_dur, price = v_new_price,
    service_id        = v_new_sid, service_name = v_new_sname,
    adjusted_at       = now(), adjusted_by = coalesce(v_who,'staff')
   where id = p_booking_id;
  return 'ok';
exception
  when exclusion_violation then return 'room_busy';
  when sqlstate 'CF001'   then return 'centre_full';
  when sqlstate 'TH001'   then return 'th2_wrong_branch';
  when sqlstate 'TH002'   then return 'th2_busy';
  when sqlstate 'TH003'   then return 'therapist_busy';
end $$;

-- ─────────────────────────────────────────────────────────────────────
-- Part 12: Updated update_booking_billing (upi2 valid)
-- ─────────────────────────────────────────────────────────────────────
drop function if exists public.update_booking_billing(uuid,text,text,int,text,int,uuid);

create or replace function public.update_booking_billing(
  p_booking_id uuid,
  p_payment_method text default null, p_addon_text text default null,
  p_addon_amt int default null, p_discount_text text default null,
  p_discount_amt int default null, p_membership_id uuid default null
)
returns text language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  b public.bookings%rowtype; m public.memberships%rowtype;
  v_pm text; v_addon text; v_amt int; v_disc_text text; v_disc int;
  v_mid uuid; v_mid_same boolean;
begin
  if auth.uid() is null then return 'no_booking'; end if;
  select * into b from public.bookings where id = p_booking_id and kind = 'booking' for update;
  if not found or not private.staff_ok(b.tenant_id, b.branch_id) then return 'no_booking'; end if;
  if b.status <> 'confirmed' then return 'not_confirmed'; end if;
  v_pm        := coalesce(p_payment_method, b.payment_method);
  v_addon     := coalesce(nullif(trim(coalesce(p_addon_text,'')), ''), b.addon_text);
  v_amt       := coalesce(p_addon_amt,    b.addon_amt);
  v_disc_text := coalesce(nullif(trim(coalesce(p_discount_text,'')), ''), b.discount_text);
  v_disc      := coalesce(p_discount_amt, b.discount_amt);
  v_mid       := case when v_pm = 'membership'
                      then coalesce(p_membership_id, b.membership_id) else null end;
  if v_pm not in ('pending','cash','card','upi','upi2','membership') then return 'invalid'; end if;
  if v_amt < 0 or v_amt > 100000 then return 'badaddon'; end if;
  if v_amt > 0 and v_addon is null then return 'badaddon'; end if;
  if length(coalesce(v_addon,'')) > 80 then return 'badaddon'; end if;
  if v_disc < 0 then return 'baddiscount'; end if;
  if v_disc > b.price + v_amt then return 'baddiscount'; end if;
  if length(coalesce(v_disc_text,'')) > 80 then return 'baddiscount'; end if;
  if v_pm = 'membership' then
    if v_mid is null then return 'membership_required'; end if;
    select * into m from public.memberships where id = v_mid and tenant_id = b.tenant_id for update;
    if not found then return 'membership_not_found'; end if;
    if not m.active then return 'membership_inactive'; end if;
  end if;
  v_mid_same := not (v_mid IS DISTINCT FROM b.membership_id);
  if b.payment_method = 'membership' and b.membership_id is not null
     and (v_pm <> 'membership' or not v_mid_same) then
    update public.memberships set remaining_sessions = least(remaining_sessions+1, total_sessions) where id = b.membership_id;
    insert into public.membership_ledger (tenant_id, membership_id, booking_id, sessions_delta, reason, created_by)
    values (b.tenant_id, b.membership_id, p_booking_id, 1, 'payment method changed – membership refund', auth.uid());
  end if;
  if v_pm = 'membership' and v_mid is not null and (b.payment_method <> 'membership' or not v_mid_same) then
    if m.remaining_sessions <= 0 then
      if b.membership_id = v_mid then
        select remaining_sessions into m.remaining_sessions from public.memberships where id = v_mid;
      end if;
      if m.remaining_sessions <= 0 then return 'membership_exhausted'; end if;
    end if;
    update public.memberships set remaining_sessions = remaining_sessions - 1 where id = v_mid;
    insert into public.membership_ledger (tenant_id, membership_id, booking_id, sessions_delta, reason, created_by)
    values (b.tenant_id, v_mid, p_booking_id, -1, 'billing updated – membership redeemed', auth.uid());
  end if;
  update public.bookings set
    payment_method = v_pm, addon_text = v_addon, addon_amt = v_amt,
    discount_text = v_disc_text, discount_amt = v_disc, membership_id = v_mid
   where id = p_booking_id;
  return 'ok';
end $$;

-- ─────────────────────────────────────────────────────────────────────
-- Part 13: Updated create_membership (upi2 valid + client_code)
-- ─────────────────────────────────────────────────────────────────────
drop function if exists public.create_membership(uuid,text,text,text,int,int,text,text,date,text);

create or replace function public.create_membership(
  p_branch_id uuid, p_kind text, p_holder_name text, p_phone text,
  p_total_sessions int, p_amount_paid int default 0,
  p_payment_mode text default 'cash', p_notes text default null,
  p_expires_on date default null, p_code text default null,
  p_client_code text default null
)
returns jsonb language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_tenant uuid := private.my_tenant();
  v_prefix text; v_max_n int; v_code text; v_id uuid; v_ccode text;
begin
  if auth.uid() is null or v_tenant is null then return jsonb_build_object('status','forbidden'); end if;
  if not private.staff_ok(v_tenant, p_branch_id) then return jsonb_build_object('status','forbidden'); end if;
  if p_kind not in ('membership','gift_certificate') then return jsonb_build_object('status','invalid_kind'); end if;
  if p_total_sessions is null or p_total_sessions <= 0 then return jsonb_build_object('status','invalid_sessions'); end if;
  if coalesce(p_amount_paid, 0) < 0 then return jsonb_build_object('status','invalid_amount'); end if;
  if p_payment_mode not in ('cash','card','upi','upi2','legacy') then return jsonb_build_object('status','invalid_payment_mode'); end if;
  if p_holder_name is null or length(trim(p_holder_name)) < 1 then return jsonb_build_object('status','invalid_name'); end if;
  if p_client_code ~ '^[0-9]{4}$' then v_ccode := p_client_code;
  elsif p_phone ~ '^[0-9]{10}$'   then v_ccode := right(p_phone, 4); end if;
  v_prefix := case when p_kind = 'membership' then 'M' else 'GC' end;
  if p_code is null or trim(p_code) = '' then
    select coalesce(max((regexp_match(code, '^'||v_prefix||'-([0-9]+)$'))[1]::int), 0) into v_max_n
      from public.memberships
     where tenant_id = v_tenant and branch_id = p_branch_id and code ~ ('^'||v_prefix||'-[0-9]+$');
    v_code := v_prefix||'-'||(v_max_n + 1);
  else v_code := trim(p_code); end if;
  begin
    insert into public.memberships (
      tenant_id, branch_id, kind, code, holder_name, phone,
      total_sessions, remaining_sessions, amount_paid, payment_mode,
      notes, expires_on, active, created_by, client_code
    ) values (
      v_tenant, p_branch_id, p_kind, v_code,
      left(trim(p_holder_name),120), p_phone,
      p_total_sessions, p_total_sessions,
      coalesce(p_amount_paid,0), p_payment_mode,
      nullif(trim(coalesce(p_notes,'')), ''),
      p_expires_on, true, auth.uid(), v_ccode
    ) returning id into v_id;
  exception when unique_violation then
    return jsonb_build_object('status','code_exists','code',v_code);
  end;
  insert into public.membership_ledger (tenant_id, membership_id, booking_id, sessions_delta, reason, created_by)
  values (v_tenant, v_id, null, p_total_sessions, 'initial load – '||v_code, auth.uid());
  return jsonb_build_object('status','ok','id',v_id,'code',v_code);
end $$;

-- ─────────────────────────────────────────────────────────────────────
-- Part 14: Grants – revoke from public/anon, grant to authenticated
-- ─────────────────────────────────────────────────────────────────────
revoke all on function
  public.end_therapy(uuid),
  public.lookup_client_by_code(text),
  public.staff_create_booking(text,text,int,date,int,text,text,text,text,text,int,text,text,int,uuid,boolean,uuid,text),
  public.reschedule_booking(uuid,uuid,date,int),
  public.update_booking_billing(uuid,text,text,int,text,int,uuid),
  public.create_membership(uuid,text,text,text,int,int,text,text,date,text,text)
from public, anon;

grant execute on function
  public.end_therapy(uuid),
  public.lookup_client_by_code(text),
  public.staff_create_booking(text,text,int,date,int,text,text,text,text,text,int,text,text,int,uuid,boolean,uuid,text),
  public.reschedule_booking(uuid,uuid,date,int),
  public.update_booking_billing(uuid,text,text,int,text,int,uuid),
  public.create_membership(uuid,text,text,text,int,int,text,text,date,text,text)
to authenticated;
