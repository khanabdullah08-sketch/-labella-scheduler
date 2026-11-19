-- =====================================================================
-- 0007  Staff API (logged-in users only). Same function names/results as the legacy
-- Thalasso project where the console already calls them (assign_therapist, end_shift).
-- Every function re-checks that the caller is staff of the row's own tenant/branch.
-- =====================================================================

-- Phone / walk-in booking. Price and names come from the menu; staff cannot override them.
-- Returns {"status":"ok","id":"<uuid>","ref":"LB-123456","room":3} or {"status":"<code>"}.
create or replace function public.staff_create_booking(
  p_branch text, p_service text, p_duration int, p_date date, p_start int,
  p_name text, p_phone text, p_notes text default null, p_source text default 'phone')
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  t public.tenants%rowtype; b public.branches%rowtype; o record;
  v_tenant uuid := private.my_tenant();
  v_ref text; v_id uuid; room int; v_who text;
begin
  if auth.uid() is null or v_tenant is null then return jsonb_build_object('status', 'forbidden'); end if;
  select * into t from public.tenants where id = v_tenant and active;
  select * into b from public.branches where tenant_id = v_tenant and code = p_branch and active;
  if not found then return jsonb_build_object('status', 'invalid'); end if;
  if not private.staff_ok(v_tenant, b.id) then return jsonb_build_object('status', 'forbidden'); end if;

  if p_name is null or length(trim(p_name)) < 2 then return jsonb_build_object('status', 'badname'); end if;
  if p_phone is null or p_phone !~ t.phone_pattern then return jsonb_build_object('status', 'badphone'); end if;
  if p_source not in ('phone', 'walkin') then return jsonb_build_object('status', 'invalid'); end if;
  if p_date is null or p_start is null then return jsonb_build_object('status', 'invalid'); end if;

  select s.name as sname, so.price into o
    from public.services s join public.service_options so on so.service_id = s.id
   where s.menu_id = b.menu_id and s.code = p_service and s.active
     and so.duration_min = p_duration and so.active;
  if not found then return jsonb_build_object('status', 'invalid'); end if;

  if p_start < b.open_min or p_start + p_duration > b.close_min then
    return jsonb_build_object('status', 'closed');
  end if;

  v_ref := private.new_ref(t.id, t.ref_prefix);
  select u.email into v_who from auth.users u where u.id = auth.uid();
  delete from public.bookings where kind = 'hold' and expires_at < now();   -- stale holds must not block staff

  for room in 1..b.rooms loop
    begin
      insert into public.bookings (tenant_id, branch_id, loc_id, loc_name, kind, status, ref, service_id,
                                   service_name, duration, price, date, start_min, end_min, room_no,
                                   name, phone, notes, source, created_by)
      values (t.id, b.id, b.code, b.name, 'booking', 'confirmed', v_ref, p_service,
              o.sname || ' (' || p_duration || ' Mins)', p_duration, o.price, p_date, p_start,
              p_start + p_duration, room, left(trim(p_name), 80), p_phone,
              left(coalesce(nullif(trim(p_notes), ''), 'None'), 500), p_source, coalesce(v_who, 'staff'))
      returning id into v_id;
      return jsonb_build_object('status', 'ok', 'id', v_id, 'ref', v_ref, 'room', room);
    exception when exclusion_violation then
      continue;
    end;
  end loop;
  return jsonb_build_object('status', 'full');
end $$;

-- Assign (or clear, with NULL) the therapist on a booking.
create or replace function public.assign_therapist(p_booking_id uuid, p_therapist_id uuid)
returns text
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare b record; d record;
begin
  select * into b from public.bookings where id = p_booking_id;
  if not found or not private.staff_ok(b.tenant_id, b.branch_id) then return 'no_booking'; end if;

  if p_therapist_id is null then
    update public.bookings set therapist_id = null, therapist_name = null where id = p_booking_id;
    return 'ok';
  end if;

  select td.arrival_min, td.shift_end_min, td.on_leave, th.name into d
    from public.therapist_days td join public.therapists th on th.id = td.therapist_id
   where td.therapist_id = p_therapist_id and td.date = b.date and td.branch_id = b.branch_id;
  if not found then return 'not_registered'; end if;

  if d.on_leave                   then return 'on_leave';    end if;
  if b.start_min < d.arrival_min  then return 'not_arrived'; end if;
  if d.shift_end_min is not null and b.end_min > d.shift_end_min then return 'shift_ended'; end if;

  update public.bookings set therapist_id = p_therapist_id, therapist_name = d.name
   where id = p_booking_id;
  return 'ok';
exception when exclusion_violation then
  return 'busy';
end $$;

-- Log the end of a therapist's shift at the current time in the tenant's timezone.
create or replace function public.end_shift(p_day_id uuid, p_force boolean default false)
returns text
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare d record; tz text; clk record; c int;
begin
  select * into d from public.therapist_days where id = p_day_id;
  if not found or not private.staff_ok(d.tenant_id, d.branch_id) then return 'not_found'; end if;

  select timezone into tz from public.tenants where id = d.tenant_id;
  select * into clk from private.tenant_clock(tz);
  if d.date <> clk.today then return 'not_today'; end if;
  if clk.now_min <= d.arrival_min then return 'before_arrival'; end if;

  select count(*) into c from public.bookings b
   where b.therapist_id = d.therapist_id and b.date = d.date
     and b.kind = 'booking' and b.status = 'confirmed' and b.end_min > clk.now_min;
  if c > 0 and not p_force then return 'has_sessions:' || c; end if;

  update public.therapist_days set shift_end_min = clk.now_min where id = p_day_id;
  return 'ok:' || clk.now_min;
end $$;
