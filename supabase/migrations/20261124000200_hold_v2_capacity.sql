-- =====================================================================
-- 0010  create_hold_v2: identical to 0006, except a branch that is full as a whole
--       (rooms not yet assigned count too) answers 'full'.
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
    exception
      when exclusion_violation then
        continue;          -- that room is taken (or still being cleaned); try the next one
      when sqlstate 'CF001' then
        return 'full';     -- the branch as a whole is full
    end;
  end loop;
  return 'full';
end $$;
