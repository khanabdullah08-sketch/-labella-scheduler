-- =====================================================================
-- 0005  Public booking API (callable by website visitors, i.e. role "anon")
-- Everything that matters is decided HERE, never by the browser:
-- room count, opening hours, duration, price, hold length, booking reference.
-- =====================================================================

create or replace function private.tenant_clock(p_tz text, out today date, out now_min int)
language sql stable
as $$
  select (now() at time zone p_tz)::date,
         extract(hour   from now() at time zone p_tz)::int * 60
       + extract(minute from now() at time zone p_tz)::int;
$$;

-- Unused booking reference such as LB-482913.
create or replace function private.new_ref(p_tenant uuid, p_prefix text)
returns text
language plpgsql
as $$
declare v text;
begin
  loop
    v := p_prefix || (100000 + floor(random() * 900000)::int)::text;
    exit when not exists (select 1 from public.bookings where tenant_id = p_tenant and ref = v);
  end loop;
  return v;
end $$;

-- Everything the booking page needs, same shape as tenants/<slug>/catalog.json.
create or replace function public.get_catalog(p_slug text)
returns jsonb
language sql stable security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'tenant', jsonb_build_object('slug', t.slug, 'name', t.name, 'refPrefix', t.ref_prefix,
      'rules', jsonb_build_object('holdMinutes', t.hold_minutes, 'bufferMins', t.buffer_mins,
        'leadMins', t.lead_mins, 'slotStep', t.slot_step, 'bookingDays', t.booking_window_days,
        'therapistMax', t.therapist_daily_cap)),
    'branches', coalesce((
      select jsonb_agg(jsonb_build_object('id', b.code, 'name', b.name, 'shortName', b.short_name,
               'city', b.city, 'phone', b.phone, 'address', b.address, 'rooms', b.rooms,
               'openMin', b.open_min, 'closeMin', b.close_min, 'menu', m.code)
             order by b.sort, b.code)
        from public.branches b join public.menus m on m.id = b.menu_id
       where b.tenant_id = t.id and b.active), '[]'::jsonb),
    'menus', coalesce((
      select jsonb_object_agg(m.code, coalesce((
        select jsonb_agg(jsonb_build_object('id', s.code, 'cat', s.category, 'name', s.name,
                 'desc', s.description,
                 'options', coalesce((select jsonb_agg(jsonb_build_object('duration', o.duration_min,
                                                                         'price', o.price)
                                                       order by o.sort, o.duration_min)
                                        from public.service_options o
                                       where o.service_id = s.id and o.active), '[]'::jsonb))
               order by s.sort, s.code)
          from public.services s where s.menu_id = m.id and s.active), '[]'::jsonb))
        from public.menus m where m.tenant_id = t.id), '{}'::jsonb)
  )
  from public.tenants t
  where t.slug = p_slug and t.active;
$$;

-- Busy intervals for one branch/day (confirmed bookings + live holds).
create or replace function public.get_busy_v2(p_tenant text, p_branch text, p_date date, p_token text default null)
returns table (s_min int, e_min int, mine boolean)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select bk.start_min, bk.end_min, coalesce(p_token is not null and bk.token = p_token, false)
    from public.bookings bk
    join public.tenants  t on t.id = bk.tenant_id
    join public.branches b on b.id = bk.branch_id
   where t.slug = p_tenant and b.code = p_branch and bk.date = p_date
     and bk.status = 'confirmed'
     and (bk.kind <> 'hold' or bk.expires_at > now());
$$;

create or replace function public.release_hold(p_token text)
returns void
language sql security definer
set search_path = public, pg_temp
as $$
  delete from public.bookings where token = p_token and kind = 'hold';
$$;
