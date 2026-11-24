-- =====================================================================
-- 0011  staff_create_booking: optional add-on (text + amount), and NO room is chosen: the booking starts
--       unassigned and staff pick the room later (assign_room). A full branch answers 'full'.
--       Price still comes from the menu; staff cannot override it here.
--       Result: {"status":"ok","id":...,"ref":"LB-123456","room":null} or {"status":"<code>"}
-- =====================================================================
drop function if exists public.staff_create_booking(text, text, int, date, int, text, text, text, text);

create or replace function public.staff_create_booking(
  p_branch text, p_service text, p_duration int, p_date date, p_start int,
  p_name text, p_phone text, p_notes text default null, p_source text default 'phone',
  p_addon_text text default null, p_addon_amt int default 0)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  t public.tenants%rowtype; b public.branches%rowtype; o record;
  v_tenant uuid := private.my_tenant();
  v_ref text; v_id uuid; v_who text;
  v_addon text := nullif(trim(coalesce(p_addon_text, '')), '');
  v_amt int := coalesce(p_addon_amt, 0);
begin
  if auth.uid() is null or v_tenant is null then return jsonb_build_object('status', 'forbidden'); end if;
  select * into t from public.tenants where id = v_tenant and active;
  if not found then return jsonb_build_object('status', 'invalid'); end if;
  select * into b from public.branches where tenant_id = v_tenant and code = p_branch and active;
  if not found then return jsonb_build_object('status', 'invalid'); end if;
  if not private.staff_ok(v_tenant, b.id) then return jsonb_build_object('status', 'forbidden'); end if;

  if p_name is null or length(trim(p_name)) < 2 then return jsonb_build_object('status', 'badname'); end if;
  if p_phone is null or p_phone !~ t.phone_pattern then return jsonb_build_object('status', 'badphone'); end if;
  if p_source not in ('phone', 'walkin') then return jsonb_build_object('status', 'invalid'); end if;
  if p_date is null or p_start is null then return jsonb_build_object('status', 'invalid'); end if;
  if v_amt < 0 or v_amt > 100000 or length(coalesce(v_addon, '')) > 80
     or (v_amt > 0 and v_addon is null) then
    return jsonb_build_object('status', 'badaddon');
  end if;

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

  begin
    insert into public.bookings (tenant_id, branch_id, loc_id, loc_name, kind, status, ref, service_id,
                                 service_name, duration, price, date, start_min, end_min, room_no,
                                 name, phone, notes, source, created_by, addon_text, addon_amt)
    values (t.id, b.id, b.code, b.name, 'booking', 'confirmed', v_ref, p_service,
            o.sname || ' (' || p_duration || ' Mins)', p_duration, o.price, p_date, p_start,
            p_start + p_duration, null, left(trim(p_name), 80), p_phone,
            left(coalesce(nullif(trim(p_notes), ''), 'None'), 500), p_source, coalesce(v_who, 'staff'),
            v_addon, v_amt)
    returning id into v_id;
  exception when sqlstate 'CF001' then
    return jsonb_build_object('status', 'full');
  end;
  return jsonb_build_object('status', 'ok', 'id', v_id, 'ref', v_ref, 'room', null);
end $$;

revoke all on function public.staff_create_booking(text, text, int, date, int, text, text, text, text, text, int) from public, anon;
grant execute on function public.staff_create_booking(text, text, int, date, int, text, text, text, text, text, int) to authenticated;
