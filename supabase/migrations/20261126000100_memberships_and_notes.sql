-- =====================================================================
-- 0016  Memberships, Client Notes & Therapist-Request Flag
--   * client_profiles table with RLS (tenant-scoped)
--   * bookings: therapist_requested boolean column
--   * memberships + membership_ledger tables with RLS
--   * bookings: payment_method += 'membership', membership_id FK
--   * Trigger: session refund when membership booking is cancelled
--   * RPC: lookup_client_by_phone
--   * RPC: create_membership (auto-code or custom)
--   * RPC: adjust_membership (owner/manager only, with ledger)
--   * Updated RPC: staff_create_booking (+ therapist_requested, membership_id)
--   * Updated RPC: assign_therapist   (+ p_therapist_requested)
--   * Updated RPC: update_booking_billing (+ membership_id, session sync)
-- =====================================================================

-- ─────────────────────────────────────────────────────────────────────
-- Part 1: client_profiles
-- ─────────────────────────────────────────────────────────────────────
create table public.client_profiles (
  tenant_id    uuid        not null references public.tenants(id) on delete cascade,
  phone        text        not null,
  client_name  text,
  preferences  text        check (preferences is null or length(preferences) <= 500),
  updated_at   timestamptz not null default now(),
  updated_by   uuid        references auth.users(id) on delete set null,
  primary key (tenant_id, phone)
);

alter table public.client_profiles enable row level security;

grant select, insert, update on public.client_profiles to authenticated;

-- Any staff member of the tenant may read profiles for that tenant
create policy cp_read on public.client_profiles
  for select to authenticated
  using (private.my_tenant() = tenant_id);

-- Any staff member of the tenant may insert new profiles
create policy cp_insert on public.client_profiles
  for insert to authenticated
  with check (private.my_tenant() = tenant_id);

-- Any staff member of the tenant may update profiles (upsert path)
create policy cp_update on public.client_profiles
  for update to authenticated
  using  (private.my_tenant() = tenant_id)
  with check (private.my_tenant() = tenant_id);

-- ─────────────────────────────────────────────────────────────────────
-- Part 2: therapist_requested flag on bookings
-- ─────────────────────────────────────────────────────────────────────
alter table public.bookings
  add column therapist_requested boolean not null default false;

-- ─────────────────────────────────────────────────────────────────────
-- Part 3: memberships table
-- ─────────────────────────────────────────────────────────────────────
create table public.memberships (
  id                 uuid        primary key default gen_random_uuid(),
  tenant_id          uuid        not null references public.tenants(id) on delete cascade,
  branch_id          uuid        not null,
  kind               text        not null
                       check (kind in ('membership','gift_certificate')),
  code               text        not null,
  holder_name        text        not null,
  phone              text        not null,
  total_sessions     int         not null check (total_sessions > 0),
  remaining_sessions int         not null check (remaining_sessions >= 0),
  amount_paid        int         not null default 0 check (amount_paid >= 0),
  payment_mode       text        not null
                       check (payment_mode in ('cash','card','upi','legacy')),
  notes              text,
  expires_on         date,
  active             boolean     not null default true,
  created_by         uuid        references auth.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  constraint memberships_remaining_lte_total
    check (remaining_sessions <= total_sessions),
  constraint memberships_code_unique
    unique (tenant_id, branch_id, code),
  foreign key (branch_id, tenant_id) references public.branches(id, tenant_id)
);

create index memberships_tenant_phone_idx  on public.memberships (tenant_id, phone);
create index memberships_branch_active_idx on public.memberships (branch_id, active);

-- ─────────────────────────────────────────────────────────────────────
-- Part 4: membership_ledger table
-- ─────────────────────────────────────────────────────────────────────
create table public.membership_ledger (
  id             uuid        primary key default gen_random_uuid(),
  tenant_id      uuid        not null references public.tenants(id) on delete cascade,
  membership_id  uuid        not null references public.memberships(id) on delete cascade,
  booking_id     uuid        references public.bookings(id) on delete set null,
  sessions_delta int         not null,
  reason         text        not null,
  created_by     uuid        references auth.users(id) on delete set null,
  created_at     timestamptz not null default now()
);

create index ledger_membership_idx on public.membership_ledger (membership_id);
create index ledger_booking_idx    on public.membership_ledger (booking_id);

-- ─────────────────────────────────────────────────────────────────────
-- Part 5: RLS for memberships + membership_ledger
-- ─────────────────────────────────────────────────────────────────────
alter table public.memberships       enable row level security;
alter table public.membership_ledger enable row level security;

grant select, insert, update on public.memberships       to authenticated;
grant select, insert          on public.membership_ledger to authenticated;

-- Staff may read memberships for their branch
create policy mbr_read on public.memberships
  for select to authenticated
  using (private.staff_ok(tenant_id, branch_id));

-- Staff may create memberships for their branch
create policy mbr_insert on public.memberships
  for insert to authenticated
  with check (private.staff_ok(tenant_id, branch_id));

-- Only owners/managers may update memberships
create policy mbr_update on public.memberships
  for update to authenticated
  using  (private.is_manager(tenant_id))
  with check (private.is_manager(tenant_id));

-- Any tenant staff may read the ledger for their tenant
create policy ledger_read on public.membership_ledger
  for select to authenticated
  using (private.my_tenant() = tenant_id);

-- Any tenant staff may insert ledger entries (via RPC path)
create policy ledger_insert on public.membership_ledger
  for insert to authenticated
  with check (private.my_tenant() = tenant_id);

-- ─────────────────────────────────────────────────────────────────────
-- Part 6: Update bookings.payment_method check + add membership_id FK
-- ─────────────────────────────────────────────────────────────────────
-- Drop the existing auto-named check and replace with one that includes 'membership'
alter table public.bookings
  drop constraint if exists bookings_payment_method_check;

alter table public.bookings
  add constraint bookings_payment_method_check
    check (payment_method in ('pending','cash','card','upi','membership'));

alter table public.bookings
  add column membership_id uuid references public.memberships(id) on delete set null;

create index bookings_membership_idx on public.bookings (membership_id)
  where membership_id is not null;

-- ─────────────────────────────────────────────────────────────────────
-- Part 7: Trigger – refund 1 session when a membership-paid booking
--          is cancelled
-- ─────────────────────────────────────────────────────────────────────
create or replace function private.membership_cancel_refund()
returns trigger language plpgsql security definer
set search_path = public, pg_temp as $$
begin
  -- Only fire when a confirmed booking is being cancelled
  -- and it was paid by membership
  if old.status = 'confirmed'
     and new.status = 'cancelled'
     and old.payment_method = 'membership'
     and old.membership_id is not null
  then
    -- Refund 1 session, never exceeding total_sessions
    update public.memberships
       set remaining_sessions = least(remaining_sessions + 1, total_sessions)
     where id = old.membership_id;

    insert into public.membership_ledger
      (tenant_id, membership_id, booking_id, sessions_delta, reason, created_by)
    values
      (old.tenant_id, old.membership_id, old.id, 1,
       'booking cancelled – session refunded', auth.uid());
  end if;
  return new;
end $$;

create trigger booking_membership_cancel_refund
  after update of status on public.bookings
  for each row execute function private.membership_cancel_refund();

-- ─────────────────────────────────────────────────────────────────────
-- Part 8: lookup_client_by_phone
--   Returns: profile preferences, visit count, last visit date/treatment,
--            and all active memberships/gift certificates with branch name,
--            code, kind, and remaining sessions.
-- ─────────────────────────────────────────────────────────────────────
create or replace function public.lookup_client_by_phone(p_phone text)
returns jsonb language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_tenant         uuid := private.my_tenant();
  v_has_profile    boolean := false;
  v_client_name    text;
  v_preferences    text;
  v_profile_upd    timestamptz;
  v_visit_count    bigint;
  v_last_date      date;
  v_last_treatment text;
  v_memberships    jsonb;
begin
  if auth.uid() is null or v_tenant is null then
    return jsonb_build_object('status','forbidden');
  end if;

  -- Client profile (optional – may not exist yet)
  select client_name, preferences, updated_at
    into v_client_name, v_preferences, v_profile_upd
    from public.client_profiles
   where tenant_id = v_tenant and phone = p_phone;
  v_has_profile := found;

  -- Total confirmed visit count and last visit date
  select count(*), max(date)
    into v_visit_count, v_last_date
    from public.bookings
   where tenant_id = v_tenant and phone = p_phone
     and kind = 'booking' and status = 'confirmed';

  -- Last treatment name (most recent by date + start_min)
  select service_name
    into v_last_treatment
    from public.bookings
   where tenant_id = v_tenant and phone = p_phone
     and kind = 'booking' and status = 'confirmed'
   order by date desc, start_min desc
   limit 1;

  -- All active memberships and gift certificates
  select jsonb_agg(
    jsonb_build_object(
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
    ) order by m.created_at desc
  )
    into v_memberships
    from public.memberships m
    join public.branches br on br.id = m.branch_id
   where m.tenant_id = v_tenant
     and m.phone = p_phone
     and m.active = true;

  return jsonb_build_object(
    'status',          'ok',
    'phone',           p_phone,
    'profile',         case
                         when v_has_profile then jsonb_build_object(
                           'client_name', v_client_name,
                           'preferences', v_preferences,
                           'updated_at',  v_profile_upd
                         )
                         else to_jsonb(null::text)
                       end,
    'visit_count',     coalesce(v_visit_count, 0),
    'last_visit_date', v_last_date,
    'last_treatment',  v_last_treatment,
    'memberships',     coalesce(v_memberships, '[]'::jsonb)
  );
end $$;

-- ─────────────────────────────────────────────────────────────────────
-- Part 9: create_membership
--   Auto-generates M-N / GC-N code when p_code is blank.
--   Accepts a custom code (e.g. 'M-1') for manager migration with
--   p_amount_paid = 0.  Inserts the initial ledger entry.
-- ─────────────────────────────────────────────────────────────────────
create or replace function public.create_membership(
  p_branch_id      uuid,
  p_kind           text,          -- 'membership' | 'gift_certificate'
  p_holder_name    text,
  p_phone          text,
  p_total_sessions int,
  p_amount_paid    int     default 0,
  p_payment_mode   text    default 'cash',
  p_notes          text    default null,
  p_expires_on     date    default null,
  p_code           text    default null   -- null / blank = auto-generate
)
returns jsonb language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_tenant uuid := private.my_tenant();
  v_prefix text;
  v_max_n  int;
  v_code   text;
  v_id     uuid;
begin
  if auth.uid() is null or v_tenant is null then
    return jsonb_build_object('status','forbidden');
  end if;
  if not private.staff_ok(v_tenant, p_branch_id) then
    return jsonb_build_object('status','forbidden');
  end if;
  if p_kind not in ('membership','gift_certificate') then
    return jsonb_build_object('status','invalid_kind');
  end if;
  if p_total_sessions is null or p_total_sessions <= 0 then
    return jsonb_build_object('status','invalid_sessions');
  end if;
  if coalesce(p_amount_paid, 0) < 0 then
    return jsonb_build_object('status','invalid_amount');
  end if;
  if p_payment_mode not in ('cash','card','upi','legacy') then
    return jsonb_build_object('status','invalid_payment_mode');
  end if;
  if p_holder_name is null or length(trim(p_holder_name)) < 1 then
    return jsonb_build_object('status','invalid_name');
  end if;

  v_prefix := case when p_kind = 'membership' then 'M' else 'GC' end;

  if p_code is null or trim(p_code) = '' then
    -- Auto-generate: find the highest numeric suffix for this prefix in this branch
    select coalesce(
      max((regexp_match(code, '^' || v_prefix || '-([0-9]+)$'))[1]::int), 0
    ) into v_max_n
    from public.memberships
    where tenant_id = v_tenant
      and branch_id = p_branch_id
      and code ~ ('^' || v_prefix || '-[0-9]+$');
    v_code := v_prefix || '-' || (v_max_n + 1);
  else
    v_code := trim(p_code);
  end if;

  begin
    insert into public.memberships (
      tenant_id, branch_id, kind, code, holder_name, phone,
      total_sessions, remaining_sessions, amount_paid, payment_mode,
      notes, expires_on, active, created_by
    ) values (
      v_tenant, p_branch_id, p_kind, v_code,
      left(trim(p_holder_name), 120), p_phone,
      p_total_sessions, p_total_sessions,
      coalesce(p_amount_paid, 0), p_payment_mode,
      nullif(trim(coalesce(p_notes, '')), ''),
      p_expires_on, true, auth.uid()
    ) returning id into v_id;
  exception when unique_violation then
    return jsonb_build_object('status','code_exists','code',v_code);
  end;

  -- Initial ledger entry (+total_sessions)
  insert into public.membership_ledger
    (tenant_id, membership_id, booking_id, sessions_delta, reason, created_by)
  values
    (v_tenant, v_id, null, p_total_sessions,
     'initial load – ' || v_code, auth.uid());

  return jsonb_build_object('status','ok','id',v_id,'code',v_code);
end $$;

-- ─────────────────────────────────────────────────────────────────────
-- Part 10: adjust_membership  (owner / manager only)
--   Updates remaining_sessions, code, expiry, or active status.
--   Always writes a ledger audit entry.
--   p_clear_expiry = true  → sets expires_on = null
-- ─────────────────────────────────────────────────────────────────────
create or replace function public.adjust_membership(
  p_membership_id  uuid,
  p_remaining      int     default null,  -- set new remaining count
  p_code           text    default null,  -- rename code
  p_expires_on     date    default null,  -- set / change expiry
  p_clear_expiry   boolean default false, -- true = remove expiry date
  p_active         boolean default null,  -- activate / deactivate
  p_reason         text    default 'manual adjustment'
)
returns jsonb language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_tenant uuid := private.my_tenant();
  m        public.memberships%rowtype;
  v_delta  int := 0;
begin
  if auth.uid() is null or v_tenant is null then
    return jsonb_build_object('status','forbidden');
  end if;
  if not private.is_manager(v_tenant) then
    return jsonb_build_object('status','forbidden');
  end if;

  select * into m from public.memberships
   where id = p_membership_id and tenant_id = v_tenant
   for update;
  if not found then return jsonb_build_object('status','not_found'); end if;

  if p_remaining is not null then
    if p_remaining < 0 or p_remaining > m.total_sessions then
      return jsonb_build_object('status','invalid_sessions');
    end if;
    v_delta := p_remaining - m.remaining_sessions;
  end if;

  begin
    update public.memberships set
      remaining_sessions = coalesce(p_remaining, remaining_sessions),
      code               = coalesce(nullif(trim(coalesce(p_code,'')), ''), code),
      expires_on         = case
                             when p_clear_expiry then null
                             when p_expires_on is not null then p_expires_on
                             else expires_on
                           end,
      active             = coalesce(p_active, active)
    where id = p_membership_id;
  exception when unique_violation then
    return jsonb_build_object('status','code_exists');
  end;

  insert into public.membership_ledger
    (tenant_id, membership_id, booking_id, sessions_delta, reason, created_by)
  values
    (v_tenant, p_membership_id, null, v_delta,
     coalesce(nullif(trim(coalesce(p_reason,'')), ''), 'manual adjustment'),
     auth.uid());

  return jsonb_build_object('status','ok','delta',v_delta);
end $$;

-- ─────────────────────────────────────────────────────────────────────
-- Part 11: staff_create_booking – adds p_therapist_requested + p_membership_id
--   When p_payment_method = 'membership':
--     • validates membership (active, not exhausted, not expired)
--     • deducts 1 remaining_session
--     • inserts a ledger entry
-- ─────────────────────────────────────────────────────────────────────
drop function if exists public.staff_create_booking(text,text,int,date,int,text,text,text,text,text,int,text,text,int,uuid);

create or replace function public.staff_create_booking(
  p_branch              text,
  p_service             text,
  p_duration            int,
  p_date                date,
  p_start               int,
  p_name                text,
  p_phone               text,
  p_notes               text    default null,
  p_source              text    default 'phone',
  p_addon_text          text    default null,
  p_addon_amt           int     default 0,
  p_payment_method      text    default 'pending',
  p_discount_text       text    default null,
  p_discount_amt        int     default 0,
  p_therapist_id_2      uuid    default null,
  p_therapist_requested boolean default false,
  p_membership_id       uuid    default null
)
returns jsonb language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  t      public.tenants%rowtype;
  b      public.branches%rowtype;
  o      record;
  m      public.memberships%rowtype;
  v_tenant uuid := private.my_tenant();
  v_ref  text; v_id uuid; v_who text;
  v_addon      text := nullif(trim(coalesce(p_addon_text,'')), '');
  v_amt        int  := coalesce(p_addon_amt, 0);
  v_disc_text  text := nullif(trim(coalesce(p_discount_text,'')), '');
  v_disc       int  := coalesce(p_discount_amt, 0);
  v_pm         text := coalesce(p_payment_method, 'pending');
  v_mid        uuid := p_membership_id;
begin
  if auth.uid() is null or v_tenant is null then
    return jsonb_build_object('status','forbidden');
  end if;
  select * into t from public.tenants where id = v_tenant and active;
  if not found then return jsonb_build_object('status','invalid'); end if;
  select * into b from public.branches
   where tenant_id = v_tenant and code = p_branch and active;
  if not found then return jsonb_build_object('status','invalid'); end if;
  if not private.staff_ok(v_tenant, b.id) then
    return jsonb_build_object('status','forbidden');
  end if;
  if p_name is null or length(trim(p_name)) < 2 then
    return jsonb_build_object('status','badname');
  end if;
  if p_phone is null or p_phone !~ t.phone_pattern then
    return jsonb_build_object('status','badphone');
  end if;
  if p_source not in ('phone','walkin') then
    return jsonb_build_object('status','invalid');
  end if;
  if p_date is null or p_start is null then
    return jsonb_build_object('status','invalid');
  end if;
  if v_amt < 0 or v_amt > 100000 or length(coalesce(v_addon,'')) > 80
     or (v_amt > 0 and v_addon is null) then
    return jsonb_build_object('status','badaddon');
  end if;
  if v_pm not in ('pending','cash','card','upi','membership') then
    return jsonb_build_object('status','invalid');
  end if;
  if v_disc < 0 or v_disc > 100000 then
    return jsonb_build_object('status','baddiscount');
  end if;

  -- Membership validation & row-lock before the booking insert
  if v_pm = 'membership' then
    if v_mid is null then
      return jsonb_build_object('status','membership_required');
    end if;
    select * into m from public.memberships
     where id = v_mid and tenant_id = v_tenant
     for update;
    if not found then
      return jsonb_build_object('status','membership_not_found');
    end if;
    if not m.active then
      return jsonb_build_object('status','membership_inactive');
    end if;
    if m.remaining_sessions <= 0 then
      return jsonb_build_object('status','membership_exhausted');
    end if;
    if m.expires_on is not null and m.expires_on < p_date then
      return jsonb_build_object('status','membership_expired');
    end if;
  else
    v_mid := null;
  end if;

  select s.name as sname, so.price into o
    from public.services s
    join public.service_options so on so.service_id = s.id
   where s.menu_id = b.menu_id and s.code = p_service and s.active
     and so.duration_min = p_duration and so.active;
  if not found then return jsonb_build_object('status','invalid'); end if;
  if v_disc > o.price + v_amt then
    return jsonb_build_object('status','baddiscount');
  end if;
  if p_start < b.open_min or p_start + p_duration > b.close_min then
    return jsonb_build_object('status','closed');
  end if;

  v_ref := private.new_ref(t.id, t.ref_prefix);
  select u.email into v_who from auth.users u where u.id = auth.uid();
  delete from public.bookings where kind = 'hold' and expires_at < now();

  begin
    insert into public.bookings (
      tenant_id, branch_id, loc_id, loc_name, kind, status, ref,
      service_id, service_name, duration, price,
      date, start_min, end_min, room_no,
      name, phone, notes, source, created_by,
      addon_text, addon_amt,
      payment_method, discount_text, discount_amt,
      therapist_id_2, therapist_requested, membership_id
    ) values (
      t.id, b.id, b.code, b.name, 'booking', 'confirmed', v_ref,
      p_service,
      o.sname || ' (' || p_duration || ' Mins)',
      p_duration, o.price,
      p_date, p_start, p_start + p_duration, null,
      left(trim(p_name), 80), p_phone,
      left(coalesce(nullif(trim(p_notes),''), 'None'), 500),
      p_source, coalesce(v_who, 'staff'),
      v_addon, v_amt,
      v_pm, v_disc_text, v_disc,
      p_therapist_id_2, coalesce(p_therapist_requested, false), v_mid
    ) returning id into v_id;
  exception
    when sqlstate 'CF001' then return jsonb_build_object('status','full');
    when sqlstate 'TH001' then return jsonb_build_object('status','th2_wrong_branch');
    when sqlstate 'TH002' then return jsonb_build_object('status','th2_busy');
    when sqlstate 'TH003' then return jsonb_build_object('status','th1_busy_as_secondary');
  end;

  -- Deduct 1 session and write ledger entry
  if v_pm = 'membership' and v_mid is not null then
    update public.memberships
       set remaining_sessions = remaining_sessions - 1
     where id = v_mid;

    insert into public.membership_ledger
      (tenant_id, membership_id, booking_id, sessions_delta, reason, created_by)
    values
      (v_tenant, v_mid, v_id, -1, 'booking ' || v_ref, auth.uid());
  end if;

  return jsonb_build_object('status','ok','id',v_id,'ref',v_ref,'room',null);
end $$;

-- ─────────────────────────────────────────────────────────────────────
-- Part 12: assign_therapist – adds p_therapist_requested boolean
-- ─────────────────────────────────────────────────────────────────────
drop function if exists public.assign_therapist(uuid, uuid, text);

create or replace function public.assign_therapist(
  p_booking_id          uuid,
  p_therapist_id        uuid,
  p_slot                text    default 'primary',
  p_therapist_requested boolean default false
)
returns text language plpgsql security definer
set search_path = public, pg_temp as $$
declare b record; d record;
begin
  if p_slot not in ('primary','secondary') then return 'bad_input'; end if;
  select * into b from public.bookings where id = p_booking_id;
  if not found or not private.staff_ok(b.tenant_id, b.branch_id) then
    return 'no_booking';
  end if;

  if p_therapist_id is null then
    if p_slot = 'primary' then
      update public.bookings
         set therapist_id        = null,
             therapist_name      = null,
             therapist_requested = coalesce(p_therapist_requested, therapist_requested)
       where id = p_booking_id;
    else
      update public.bookings
         set therapist_id_2      = null,
             therapist_requested = coalesce(p_therapist_requested, therapist_requested)
       where id = p_booking_id;
    end if;
    return 'ok';
  end if;

  select td.arrival_min, td.shift_end_min, td.on_leave, th.name into d
    from public.therapist_days td
    join public.therapists th on th.id = td.therapist_id
   where td.therapist_id = p_therapist_id
     and td.date = b.date and td.branch_id = b.branch_id;
  if not found       then return 'not_registered'; end if;
  if d.on_leave      then return 'on_leave';        end if;
  if b.start_min < d.arrival_min then return 'not_arrived'; end if;
  if d.shift_end_min is not null and b.end_min > d.shift_end_min then
    return 'shift_ended';
  end if;

  if p_slot = 'primary' then
    update public.bookings
       set therapist_id        = p_therapist_id,
           therapist_name      = d.name,
           therapist_requested = coalesce(p_therapist_requested, therapist_requested)
     where id = p_booking_id;
  else
    update public.bookings
       set therapist_id_2      = p_therapist_id,
           therapist_requested = coalesce(p_therapist_requested, therapist_requested)
     where id = p_booking_id;
  end if;
  return 'ok';
exception
  when exclusion_violation then return 'busy';
  when sqlstate 'TH001'   then return 'th2_wrong_branch';
  when sqlstate 'TH002'   then return 'th2_busy';
  when sqlstate 'TH003'   then return 'th1_busy_as_secondary';
end $$;

-- ─────────────────────────────────────────────────────────────────────
-- Part 13: update_booking_billing – adds p_membership_id; syncs sessions
--   Switching TO   membership  → deduct 1 session, write ledger
--   Switching FROM membership  → refund 1 session, write ledger
--   Switching membership → same membership → no session change
-- ─────────────────────────────────────────────────────────────────────
drop function if exists public.update_booking_billing(uuid,text,text,int,text,int);

create or replace function public.update_booking_billing(
  p_booking_id     uuid,
  p_payment_method text    default null,
  p_addon_text     text    default null,
  p_addon_amt      int     default null,
  p_discount_text  text    default null,
  p_discount_amt   int     default null,
  p_membership_id  uuid    default null
)
returns text language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  b           public.bookings%rowtype;
  m           public.memberships%rowtype;
  v_pm        text;
  v_addon     text;
  v_amt       int;
  v_disc_text text;
  v_disc      int;
  v_mid       uuid;
  v_mid_same  boolean;
begin
  if auth.uid() is null then return 'no_booking'; end if;
  select * into b from public.bookings
   where id = p_booking_id and kind = 'booking'
   for update;
  if not found or not private.staff_ok(b.tenant_id, b.branch_id) then
    return 'no_booking';
  end if;
  if b.status <> 'confirmed' then return 'not_confirmed'; end if;

  v_pm        := coalesce(p_payment_method, b.payment_method);
  v_addon     := coalesce(nullif(trim(coalesce(p_addon_text,'')), ''), b.addon_text);
  v_amt       := coalesce(p_addon_amt,    b.addon_amt);
  v_disc_text := coalesce(nullif(trim(coalesce(p_discount_text,'')), ''), b.discount_text);
  v_disc      := coalesce(p_discount_amt, b.discount_amt);
  v_mid       := case when v_pm = 'membership'
                      then coalesce(p_membership_id, b.membership_id)
                      else null
                 end;

  if v_pm not in ('pending','cash','card','upi','membership') then return 'invalid'; end if;
  if v_amt < 0 or v_amt > 100000 then return 'badaddon'; end if;
  if v_amt > 0 and v_addon is null then return 'badaddon'; end if;
  if length(coalesce(v_addon,'')) > 80 then return 'badaddon'; end if;
  if v_disc < 0 then return 'baddiscount'; end if;
  if v_disc > b.price + v_amt then return 'baddiscount'; end if;
  if length(coalesce(v_disc_text,'')) > 80 then return 'baddiscount'; end if;

  if v_pm = 'membership' then
    if v_mid is null then return 'membership_required'; end if;
    select * into m from public.memberships
     where id = v_mid and tenant_id = b.tenant_id
     for update;
    if not found then return 'membership_not_found'; end if;
    if not m.active then return 'membership_inactive'; end if;
  end if;

  v_mid_same := not (v_mid IS DISTINCT FROM b.membership_id);

  -- Step A: Refund old membership if leaving it
  if b.payment_method = 'membership'
     and b.membership_id is not null
     and (v_pm <> 'membership' or not v_mid_same)
  then
    update public.memberships
       set remaining_sessions = least(remaining_sessions + 1, total_sessions)
     where id = b.membership_id;

    insert into public.membership_ledger
      (tenant_id, membership_id, booking_id, sessions_delta, reason, created_by)
    values
      (b.tenant_id, b.membership_id, p_booking_id, 1,
       'payment method changed – membership refund', auth.uid());
  end if;

  -- Step B: Deduct new membership if switching to it (or a different one)
  if v_pm = 'membership'
     and v_mid is not null
     and (b.payment_method <> 'membership' or not v_mid_same)
  then
    if m.remaining_sessions <= 0 then
      if b.membership_id = v_mid then
        select remaining_sessions into m.remaining_sessions
          from public.memberships where id = v_mid;
      end if;
      if m.remaining_sessions <= 0 then return 'membership_exhausted'; end if;
    end if;

    update public.memberships
       set remaining_sessions = remaining_sessions - 1
     where id = v_mid;

    insert into public.membership_ledger
      (tenant_id, membership_id, booking_id, sessions_delta, reason, created_by)
    values
      (b.tenant_id, v_mid, p_booking_id, -1,
       'billing updated – membership redeemed', auth.uid());
  end if;

  update public.bookings set
    payment_method = v_pm,
    addon_text     = v_addon,
    addon_amt      = v_amt,
    discount_text  = v_disc_text,
    discount_amt   = v_disc,
    membership_id  = v_mid
   where id = p_booking_id;

  return 'ok';
end $$;

-- ─────────────────────────────────────────────────────────────────────
-- Part 14: Grants for all new / replaced functions
-- ─────────────────────────────────────────────────────────────────────
revoke all on function
  public.lookup_client_by_phone(text),
  public.create_membership(uuid,text,text,text,int,int,text,text,date,text),
  public.adjust_membership(uuid,int,text,date,boolean,boolean,text),
  public.staff_create_booking(text,text,int,date,int,text,text,text,text,text,int,text,text,int,uuid,boolean,uuid),
  public.assign_therapist(uuid,uuid,text,boolean),
  public.update_booking_billing(uuid,text,text,int,text,int,uuid)
from public, anon;

grant execute on function
  public.lookup_client_by_phone(text),
  public.create_membership(uuid,text,text,text,int,int,text,text,date,text),
  public.adjust_membership(uuid,int,text,date,boolean,boolean,text),
  public.staff_create_booking(text,text,int,date,int,text,text,text,text,text,int,text,text,int,uuid,boolean,uuid),
  public.assign_therapist(uuid,uuid,text,boolean),
  public.update_booking_billing(uuid,text,text,int,text,int,uuid)
to authenticated;
