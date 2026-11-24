-- =====================================================================
-- 0009  Booking operations ported from the Thalasso Live console (part 1: columns + rules)
--   * add-ons on phone / walk-in bookings (addon_text, addon_amt)
--   * staff bookings start WITHOUT a room (room_no NULL); a database rule refuses to overbook a
--     branch (error text CENTRE_FULL, SQLSTATE CF001). Online bookings still get a room automatically.
--   * adjusted-session audit columns, and bookings.updated_at (used by the Thalasso rollback script)
-- Migrations 0001-0008 are NOT edited: LaBella's database already ran them.
-- =====================================================================

alter table public.bookings
  add column addon_text    text check (addon_text is null or length(addon_text) between 1 and 80),
  add column addon_amt     int  not null default 0 check (addon_amt between 0 and 100000),
  add column orig_duration int  check (orig_duration is null or orig_duration > 0),
  add column orig_price    int  check (orig_price is null or orig_price >= 0),
  add column adjusted_at   timestamptz,
  add column adjusted_by   text,
  add column updated_at    timestamptz not null default now();

alter table public.bookings
  add constraint bookings_addon_described check (addon_amt = 0 or addon_text is not null);

-- NULL room = "not assigned yet". The room exclusion constraint never conflicts on a NULL room.
alter table public.bookings alter column room_no drop not null;
alter table public.bookings alter column room_no drop default;

-- any change to a booking row stamps the time
create or replace function private.bookings_touch()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger bookings_touch
  before update on public.bookings
  for each row execute function private.bookings_touch();

-- Overbooking guard. Assigned rooms are already protected by the exclusion constraint; this rule also
-- covers bookings WITHOUT a room: at no moment may more bookings (cleaning gap included) be running at
-- a branch than it has rooms. Raises CENTRE_FULL (SQLSTATE CF001).
create or replace function private.bookings_capacity()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_rooms int; v_buf int; v_block int; v_peak int;
begin
  if new.status <> 'confirmed' then return new; end if;
  if new.kind = 'hold' and (new.expires_at is null or new.expires_at <= now()) then return new; end if;

  -- an unchanged or shorter booking can never add load
  if tg_op = 'UPDATE' and old.status = 'confirmed'
     and old.branch_id = new.branch_id and old.date = new.date
     and old.start_min = new.start_min and new.end_min <= old.end_min then
    return new;
  end if;

  select b.rooms into v_rooms from public.branches b where b.id = new.branch_id;
  select t.buffer_mins into v_buf from public.tenants t where t.id = new.tenant_id;
  if v_rooms is null or v_buf is null then raise exception 'Unknown branch or tenant for booking'; end if;
  if new.room_no is not null and new.room_no > v_rooms then
    raise exception 'Room % does not exist at this branch', new.room_no;
  end if;
  v_block := new.end_min + v_buf;

  perform pg_advisory_xact_lock(hashtextextended('capacity:' || new.branch_id::text || new.date::text, 0));

  -- busiest moment inside the new booking's blocked window, counting the OTHER live bookings
  select coalesce(max(c), 0) into v_peak
    from (
      select (select count(*) from public.bookings y
               where y.branch_id = new.branch_id and y.date = new.date and y.id <> new.id
                 and y.status = 'confirmed' and (y.kind = 'booking' or y.expires_at > now())
                 and y.start_min <= p.t and y.block_end_min > p.t) as c
        from (select new.start_min as t
              union
              select x.start_min from public.bookings x
               where x.branch_id = new.branch_id and x.date = new.date and x.id <> new.id
                 and x.status = 'confirmed' and (x.kind = 'booking' or x.expires_at > now())
                 and x.start_min > new.start_min and x.start_min < v_block) p
    ) q;

  if v_peak + 1 > v_rooms then
    raise exception 'CENTRE_FULL' using errcode = 'CF001';
  end if;
  return new;
end $$;

create trigger bookings_capacity
  before insert or update of start_min, end_min, status, branch_id, date, room_no on public.bookings
  for each row execute function private.bookings_capacity();
