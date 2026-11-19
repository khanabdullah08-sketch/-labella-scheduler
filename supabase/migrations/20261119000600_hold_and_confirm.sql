-- =====================================================================
-- 0006  Hold a slot, then confirm it.
-- Returns codes: ok | full | closed | invalid | baddate | toosoon | price_changed
-- =====================================================================
create or replace function public.create_hold_v2(
  p_tenant text, p_branch text, p_date date, p_start int,
  p_service text, p_duration int, p_token text, p_price_seen int default null)
returns text
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  t   public.tenants%rowtype;
  b   public.branches%rowtype;
  o   record;
  clk record;
  v_end int;
  room int;
begin
  if p_token is null or length(p_token) not between 8 and 80 then return 'invalid'; end if;
  if p_date is null or p_start is null or p_duration is null or p_service is null then return 'invalid'; end if;

  select * into t from public.tenants where slug = p_tenant and active;
  if not found then return 'invalid'; end if;
  select * into b from public.branches where tenant_id = t.id and code = p_branch and active;
  if not found then return 'invalid'; end if;

  -- The service must be on THIS branch's menu, with THIS duration; the price comes from the database.
  select s.name as sname, so.price into o
    from public.services s join public.service_options so on so.service_id = s.id
   where s.menu_id = b.menu_id and s.code = p_service and s.active
     and so.duration_min = p_duration and so.active;
  if not found then return 'invalid'; end if;
  if p_price_seen is not null and p_price_seen <> o.price then return 'price_changed'; end if;

  v_end := p_start + p_duration;
  if p_start < b.open_min or v_end > b.close_min then return 'closed'; end if;
  if (p_start - b.open_min) % t.slot_step <> 0 then return 'invalid'; end if;

  select * into clk from private.tenant_clock(t.timezone);
  if p_date < clk.today or p_date > clk.today + t.booking_window_days then return 'baddate'; end if;
  if p_date = clk.today and p_start < clk.now_min + t.lead_mins then return 'toosoon'; end if;

  delete from public.bookings where kind = 'hold' and expires_at < now();
  delete from public.bookings where kind = 'hold' and token = p_token;

  for room in 1..b.rooms loop
    begin
      insert into public.bookings (tenant_id, branch_id, loc_id, loc_name, kind, service_id, service_name,
                                   duration, price, date, start_min, end_min, room_no, token, expires_at)
      values (t.id, b.id, b.code, b.name, 'hold', p_service, o.sname || ' (' || p_duration || ' Mins)',
              p_duration, o.price, p_date, p_start, v_end, room, p_token,
              now() + make_interval(mins => t.hold_minutes));
      return 'ok';
    exception when exclusion_violation then
      continue;          -- that room is taken (or still being cleaned); try the next one
    end;
  end loop;
  return 'full';
end $$;

-- Turns a live hold into a booking and returns {"status":"ok","ref":"LB-123456"}.
create or replace function public.confirm_booking_v2(
  p_tenant text, p_token text, p_name text, p_phone text, p_notes text default null)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare t public.tenants%rowtype; v_ref text; hit int;
begin
  select * into t from public.tenants where slug = p_tenant and active;
  if not found then return jsonb_build_object('status', 'invalid'); end if;
  if p_name is null or length(trim(p_name)) < 2 then return jsonb_build_object('status', 'badname'); end if;
  if p_phone is null or p_phone !~ t.phone_pattern then return jsonb_build_object('status', 'badphone'); end if;

  v_ref := private.new_ref(t.id, t.ref_prefix);

  update public.bookings set
    kind       = 'booking',
    ref        = v_ref,
    name       = left(trim(p_name), 80),
    phone      = p_phone,
    notes      = left(coalesce(nullif(trim(p_notes), ''), 'None'), 500),
    source     = 'online',
    created_by = null,
    token      = null,
    expires_at = null
  where token = p_token and kind = 'hold' and tenant_id = t.id and expires_at > now();

  get diagnostics hit = row_count;
  if hit = 1 then return jsonb_build_object('status', 'ok', 'ref', v_ref); end if;
  return jsonb_build_object('status', 'expired');
end $$;
