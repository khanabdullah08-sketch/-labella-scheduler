-- =====================================================================
-- 0015  Ops Upgrades Phase 1
--   * bookings: payment_method, discount_text/amt, therapist_id_2,
--               reschedule history columns (orig_date, orig_start_min,
--               orig_service_id, orig_service_name)
--   * expenses table with RLS
--   * reschedule_booking + update_booking_billing RPCs
--   * assign_therapist gains p_slot ('primary'|'secondary')
--   * staff_create_booking gains payment_method, discount, therapist_id_2
-- =====================================================================

-- Part 1: New columns on bookings
alter table public.bookings
  add column payment_method  text not null default 'pending'
    check (payment_method in ('pending','cash','card','upi')),
  add column discount_text   text
    check (discount_text is null or length(discount_text) between 1 and 80),
  add column discount_amt    int  not null default 0
    check (discount_amt >= 0),
  add column therapist_id_2  uuid references public.therapists(id) on delete set null,
  add column orig_date         date,
  add column orig_start_min    int check (orig_start_min is null or orig_start_min between 0 and 1439),
  add column orig_service_id   text,
  add column orig_service_name text;

alter table public.bookings
  add constraint bookings_discount_max
    check (discount_amt <= price + addon_amt);

alter table public.bookings
  add constraint bookings_th2_not_same
    check (therapist_id_2 is null or therapist_id is null or therapist_id_2 <> therapist_id);

-- Part 2: Expenses table
create table public.expenses (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  branch_id    uuid not null,
  expense_date date not null,
  description  text not null check (length(description) between 1 and 160),
  amount       int  not null check (amount > 0),
  payment_mode text not null default 'cash' check (payment_mode in ('cash','card','upi')),
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  foreign key (branch_id, tenant_id) references public.branches(id, tenant_id)
);
create index expenses_branch_date_idx on public.expenses (branch_id, expense_date);

-- Part 3: Trigger – therapist_id_2 same-branch + cross-column double-booking guard
create or replace function private.bookings_th2_validate()
returns trigger language plpgsql security definer
set search_path = public, pg_temp as $$
begin
  if new.therapist_id_2 is null then return new; end if;
  -- must belong to same tenant+branch
  if not exists (
    select 1 from public.therapists
     where id = new.therapist_id_2
       and branch_id = new.branch_id and tenant_id = new.tenant_id
  ) then raise exception 'therapist_id_2 must belong to the same branch as the booking'
    using errcode = 'TH001'; end if;
  if new.status <> 'confirmed' or new.kind <> 'booking' then return new; end if;
  -- th2 must not overlap any primary or secondary therapist
  if exists (
    select 1 from public.bookings x where x.id <> new.id and x.date = new.date
      and x.kind = 'booking' and x.status = 'confirmed'
      and x.start_min < new.end_min and x.end_min > new.start_min
      and (x.therapist_id = new.therapist_id_2 or x.therapist_id_2 = new.therapist_id_2)
  ) then raise exception 'therapist_id_2 is already booked at this time' using errcode = 'TH002'; end if;
  -- primary must not be someone else's secondary at the same time
  if new.therapist_id is not null and exists (
    select 1 from public.bookings x where x.id <> new.id
      and x.therapist_id_2 = new.therapist_id and x.date = new.date
      and x.kind = 'booking' and x.status = 'confirmed'
      and x.start_min < new.end_min and x.end_min > new.start_min
  ) then raise exception 'therapist_id is already a secondary on another booking at this time'
    using errcode = 'TH003'; end if;
  return new;
end $$;

create trigger bookings_th2_validate
  before insert or update of therapist_id_2, therapist_id, start_min, end_min, date, status
  on public.bookings for each row execute function private.bookings_th2_validate();

-- Part 4: Trigger – expenses: force tenant, created_by, IST date default
create or replace function private.expenses_fill()
returns trigger language plpgsql security definer
set search_path = public, pg_temp as $$
declare v_tenant uuid; tz text;
begin
  v_tenant := private.my_tenant();
  if v_tenant is not null then new.tenant_id := v_tenant; end if;
  if new.tenant_id is null then raise exception 'No tenant for this expense'; end if;
  if auth.uid() is not null then new.created_by := auth.uid(); end if;
  if new.expense_date is null then
    select timezone into tz from public.tenants where id = new.tenant_id;
    new.expense_date := (now() at time zone coalesce(tz, 'UTC'))::date;
  end if;
  return new;
end $$;

create trigger expenses_fill
  before insert on public.expenses
  for each row execute function private.expenses_fill();

-- Part 5: staff_create_booking – add payment_method, discount, therapist_id_2
drop function if exists public.staff_create_booking(text,text,int,date,int,text,text,text,text,text,int);

create or replace function public.staff_create_booking(
  p_branch text, p_service text, p_duration int, p_date date, p_start int,
  p_name text, p_phone text, p_notes text default null, p_source text default 'phone',
  p_addon_text text default null, p_addon_amt int default 0,
  p_payment_method text default 'pending',
  p_discount_text text default null, p_discount_amt int default 0,
  p_therapist_id_2 uuid default null)
returns jsonb language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  t public.tenants%rowtype; b public.branches%rowtype; o record;
  v_tenant uuid := private.my_tenant();
  v_ref text; v_id uuid; v_who text;
  v_addon text := nullif(trim(coalesce(p_addon_text,'')), '');
  v_amt  int   := coalesce(p_addon_amt, 0);
  v_disc_text text := nullif(trim(coalesce(p_discount_text,'')), '');
  v_disc int   := coalesce(p_discount_amt, 0);
  v_pm   text  := coalesce(p_payment_method, 'pending');
begin
  if auth.uid() is null or v_tenant is null then return jsonb_build_object('status','forbidden'); end if;
  select * into t from public.tenants where id = v_tenant and active;
  if not found then return jsonb_build_object('status','invalid'); end if;
  select * into b from public.branches where tenant_id = v_tenant and code = p_branch and active;
  if not found then return jsonb_build_object('status','invalid'); end if;
  if not private.staff_ok(v_tenant, b.id) then return jsonb_build_object('status','forbidden'); end if;
  if p_name is null or length(trim(p_name)) < 2 then return jsonb_build_object('status','badname'); end if;
  if p_phone is null or p_phone !~ t.phone_pattern then return jsonb_build_object('status','badphone'); end if;
  if p_source not in ('phone','walkin') then return jsonb_build_object('status','invalid'); end if;
  if p_date is null or p_start is null then return jsonb_build_object('status','invalid'); end if;
  if v_amt < 0 or v_amt > 100000 or length(coalesce(v_addon,'')) > 80
     or (v_amt > 0 and v_addon is null) then return jsonb_build_object('status','badaddon'); end if;
  if v_pm not in ('pending','cash','card','upi') then return jsonb_build_object('status','invalid'); end if;
  if v_disc < 0 or v_disc > 100000 then return jsonb_build_object('status','baddiscount'); end if;
  select s.name as sname, so.price into o
    from public.services s join public.service_options so on so.service_id = s.id
   where s.menu_id = b.menu_id and s.code = p_service and s.active
     and so.duration_min = p_duration and so.active;
  if not found then return jsonb_build_object('status','invalid'); end if;
  if v_disc > o.price + v_amt then return jsonb_build_object('status','baddiscount'); end if;
  if p_start < b.open_min or p_start + p_duration > b.close_min then
    return jsonb_build_object('status','closed');
  end if;
  v_ref := private.new_ref(t.id, t.ref_prefix);
  select u.email into v_who from auth.users u where u.id = auth.uid();
  delete from public.bookings where kind = 'hold' and expires_at < now();
  begin
    insert into public.bookings (tenant_id, branch_id, loc_id, loc_name, kind, status, ref, service_id,
      service_name, duration, price, date, start_min, end_min, room_no, name, phone, notes, source,
      created_by, addon_text, addon_amt, payment_method, discount_text, discount_amt, therapist_id_2)
    values (t.id, b.id, b.code, b.name, 'booking','confirmed', v_ref, p_service,
      o.sname||' ('||p_duration||' Mins)', p_duration, o.price, p_date, p_start,
      p_start+p_duration, null, left(trim(p_name),80), p_phone,
      left(coalesce(nullif(trim(p_notes),''),'None'),500), p_source, coalesce(v_who,'staff'),
      v_addon, v_amt, v_pm, v_disc_text, v_disc, p_therapist_id_2)
    returning id into v_id;
  exception when sqlstate 'CF001' then return jsonb_build_object('status','full');
            when sqlstate 'TH001' then return jsonb_build_object('status','th2_wrong_branch');
            when sqlstate 'TH002' then return jsonb_build_object('status','th2_busy');
            when sqlstate 'TH003' then return jsonb_build_object('status','th1_busy_as_secondary');
  end;
  return jsonb_build_object('status','ok','id',v_id,'ref',v_ref,'room',null);
end $$;

-- Part 6: assign_therapist – gains p_slot ('primary'|'secondary', default 'primary')
drop function if exists public.assign_therapist(uuid, uuid);

create or replace function public.assign_therapist(
  p_booking_id uuid, p_therapist_id uuid, p_slot text default 'primary')
returns text language plpgsql security definer
set search_path = public, pg_temp as $$
declare b record; d record;
begin
  if p_slot not in ('primary','secondary') then return 'bad_input'; end if;
  select * into b from public.bookings where id = p_booking_id;
  if not found or not private.staff_ok(b.tenant_id, b.branch_id) then return 'no_booking'; end if;

  if p_therapist_id is null then
    if p_slot = 'primary' then
      update public.bookings set therapist_id = null, therapist_name = null where id = p_booking_id;
    else
      update public.bookings set therapist_id_2 = null where id = p_booking_id;
    end if;
    return 'ok';
  end if;

  select td.arrival_min, td.shift_end_min, td.on_leave, th.name into d
    from public.therapist_days td join public.therapists th on th.id = td.therapist_id
   where td.therapist_id = p_therapist_id and td.date = b.date and td.branch_id = b.branch_id;
  if not found then return 'not_registered'; end if;
  if d.on_leave                              then return 'on_leave'; end if;
  if b.start_min < d.arrival_min             then return 'not_arrived'; end if;
  if d.shift_end_min is not null and b.end_min > d.shift_end_min then return 'shift_ended'; end if;

  if p_slot = 'primary' then
    update public.bookings set therapist_id = p_therapist_id, therapist_name = d.name
     where id = p_booking_id;
  else
    update public.bookings set therapist_id_2 = p_therapist_id where id = p_booking_id;
  end if;
  return 'ok';
exception
  when exclusion_violation then return 'busy';
  when sqlstate 'TH001' then return 'th2_wrong_branch';
  when sqlstate 'TH002' then return 'th2_busy';
  when sqlstate 'TH003' then return 'th1_busy_as_secondary';
end $$;

-- Part 7: reschedule_booking
-- p_service_option_id: service_options.id (null = keep current)
-- p_date, p_start_min: null = keep current
-- Result: ok | no_booking | not_confirmed | invalid | closed | therapist_busy |
--         th2_busy | room_busy | centre_full | no_change
create or replace function public.reschedule_booking(
  p_booking_id uuid,
  p_service_option_id uuid default null,
  p_date date default null,
  p_start_min int default null)
returns text language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  b   public.bookings%rowtype;
  br  public.branches%rowtype;
  o   record;
  v_buf int; v_new_end int; v_who text;
  v_new_date date; v_new_start int;
  v_new_dur int; v_new_price int;
  v_new_sid text; v_new_sname text;
begin
  if auth.uid() is null then return 'no_booking'; end if;
  select * into b from public.bookings where id = p_booking_id and kind = 'booking' for update;
  if not found or not private.staff_ok(b.tenant_id, b.branch_id) then return 'no_booking'; end if;
  if b.status <> 'confirmed' then return 'not_confirmed'; end if;

  -- Resolve new values, defaulting to current
  v_new_date  := coalesce(p_date, b.date);
  v_new_start := coalesce(p_start_min, b.start_min);

  if p_service_option_id is not null then
    select so.duration_min, so.price, s.code, s.name||' ('||so.duration_min||' Mins)' as sname
      into o
      from public.service_options so join public.services s on s.id = so.service_id
     where so.id = p_service_option_id
       and s.menu_id = (select menu_id from public.branches where id = b.branch_id)
       and s.active and so.active;
    if not found then return 'invalid'; end if;
    v_new_dur   := o.duration_min;
    v_new_price := o.price;
    v_new_sid   := o.code;
    v_new_sname := o.sname;
  else
    v_new_dur   := b.duration;
    v_new_price := b.price;
    v_new_sid   := b.service_id;
    v_new_sname := b.service_name;
  end if;

  -- No change at all
  if v_new_date = b.date and v_new_start = b.start_min and v_new_dur = b.duration
     and v_new_price = b.price then
    return 'no_change';
  end if;

  v_new_end := v_new_start + v_new_dur;
  select * into br from public.branches where id = b.branch_id;
  if v_new_start < br.open_min or v_new_end > br.close_min then return 'closed'; end if;
  select buffer_mins into v_buf from public.tenants where id = b.tenant_id;

  -- therapist_id conflict on new window
  if b.therapist_id is not null and exists (
    select 1 from public.bookings x where x.id <> b.id
      and x.therapist_id = b.therapist_id and x.date = v_new_date
      and x.kind = 'booking' and x.status = 'confirmed'
      and x.start_min < v_new_end and x.end_min > v_new_start
  ) then return 'therapist_busy'; end if;

  -- therapist_id_2 conflict on new window
  if b.therapist_id_2 is not null and exists (
    select 1 from public.bookings x where x.id <> b.id
      and x.date = v_new_date and x.kind = 'booking' and x.status = 'confirmed'
      and x.start_min < v_new_end and x.end_min > v_new_start
      and (x.therapist_id = b.therapist_id_2 or x.therapist_id_2 = b.therapist_id_2)
  ) then return 'th2_busy'; end if;

  -- room conflict on new window (only if assigned)
  if b.room_no is not null and exists (
    select 1 from public.bookings x where x.id <> b.id
      and x.branch_id = b.branch_id and x.date = v_new_date and x.room_no = b.room_no
      and x.status = 'confirmed'
      and x.start_min < v_new_end + v_buf and x.block_end_min > v_new_start
  ) then return 'room_busy'; end if;

  select u.email into v_who from auth.users u where u.id = auth.uid();

  update public.bookings set
    -- log first change only
    orig_date         = coalesce(orig_date,         b.date),
    orig_start_min    = coalesce(orig_start_min,     b.start_min),
    orig_service_id   = coalesce(orig_service_id,    b.service_id),
    orig_service_name = coalesce(orig_service_name,  b.service_name),
    -- keep existing orig_duration/orig_price if already set
    orig_duration     = coalesce(orig_duration, b.duration),
    orig_price        = coalesce(orig_price,    b.price),
    -- apply new values
    date              = v_new_date,
    start_min         = v_new_start,
    end_min           = v_new_end,
    duration          = v_new_dur,
    price             = v_new_price,
    service_id        = v_new_sid,
    service_name      = v_new_sname,
    adjusted_at       = now(),
    adjusted_by       = coalesce(v_who,'staff')
   where id = p_booking_id;
  return 'ok';
exception
  when exclusion_violation           then return 'room_busy';
  when sqlstate 'CF001'              then return 'centre_full';
  when sqlstate 'TH001'               then return 'th2_wrong_branch';
  when sqlstate 'TH002'               then return 'th2_busy';
  when sqlstate 'TH003'               then return 'therapist_busy';
end $$;

-- Part 8: update_booking_billing
-- Updates payment_method, addon_text/amt, discount_text/amt on a confirmed booking.
-- Result: ok | no_booking | not_confirmed | badaddon | baddiscount | invalid
create or replace function public.update_booking_billing(
  p_booking_id    uuid,
  p_payment_method text default null,
  p_addon_text    text default null,
  p_addon_amt     int  default null,
  p_discount_text text default null,
  p_discount_amt  int  default null)
returns text language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  b     public.bookings%rowtype;
  v_pm  text; v_addon text; v_amt int; v_disc_text text; v_disc int;
begin
  if auth.uid() is null then return 'no_booking'; end if;
  select * into b from public.bookings where id = p_booking_id and kind = 'booking' for update;
  if not found or not private.staff_ok(b.tenant_id, b.branch_id) then return 'no_booking'; end if;
  if b.status <> 'confirmed' then return 'not_confirmed'; end if;

  -- Resolve each field, defaulting to existing value
  v_pm        := coalesce(p_payment_method, b.payment_method);
  v_addon     := coalesce(nullif(trim(coalesce(p_addon_text,'')), ''), b.addon_text);
  v_amt       := coalesce(p_addon_amt,    b.addon_amt);
  v_disc_text := coalesce(nullif(trim(coalesce(p_discount_text,'')), ''), b.discount_text);
  v_disc      := coalesce(p_discount_amt, b.discount_amt);

  if v_pm not in ('pending','cash','card','upi') then return 'invalid'; end if;
  if v_amt < 0 or v_amt > 100000 then return 'badaddon'; end if;
  if v_amt > 0 and v_addon is null then return 'badaddon'; end if;
  if length(coalesce(v_addon,'')) > 80 then return 'badaddon'; end if;
  if v_disc < 0 then return 'baddiscount'; end if;
  if v_disc > b.price + v_amt then return 'baddiscount'; end if;
  if length(coalesce(v_disc_text,'')) > 80 then return 'baddiscount'; end if;

  update public.bookings set
    payment_method = v_pm,
    addon_text     = v_addon,
    addon_amt      = v_amt,
    discount_text  = v_disc_text,
    discount_amt   = v_disc
   where id = p_booking_id;
  return 'ok';
end $$;

-- Part 9: RLS for expenses
alter table public.expenses enable row level security;

grant select, insert, update, delete on public.expenses to authenticated;

-- any staff may insert or view expenses for their own tenant+branch
create policy expenses_insert on public.expenses for insert to authenticated
  with check (private.staff_ok(tenant_id, branch_id));

create policy expenses_read on public.expenses for select to authenticated
  using (private.staff_ok(tenant_id, branch_id));

-- only owners/managers may update or delete
create policy expenses_update on public.expenses for update to authenticated
  using  (private.is_manager(tenant_id))
  with check (private.is_manager(tenant_id));

create policy expenses_delete on public.expenses for delete to authenticated
  using (private.is_manager(tenant_id));

-- Part 10: Grants for new functions
revoke all on function
  public.staff_create_booking(text,text,int,date,int,text,text,text,text,text,int,text,text,int,uuid),
  public.assign_therapist(uuid,uuid,text),
  public.reschedule_booking(uuid,uuid,date,int),
  public.update_booking_billing(uuid,text,text,int,text,int)
from public, anon;

grant execute on function
  public.staff_create_booking(text,text,int,date,int,text,text,text,text,text,int,text,text,int,uuid),
  public.assign_therapist(uuid,uuid,text),
  public.reschedule_booking(uuid,uuid,date,int),
  public.update_booking_billing(uuid,text,text,int,text,int)
to authenticated;
