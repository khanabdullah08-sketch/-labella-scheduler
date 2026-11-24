-- =====================================================================
-- 0012  assign_room + adjust_session (ported from the Thalasso Live database, now tenant-aware)
--
-- assign_room: ok | busy | no_booking | not_confirmed | no_such_room
-- adjust_session: change duration / price of a confirmed booking.
--   * a duration + price that is on the branch's ACTIVE menu for that treatment: any staff member
--   * custom minutes or a custom price: owner / manager only  ('not_allowed' for front desk)
--   The first change remembers the original duration and price; every change records who and when.
--   Result: ok | no_change | bad_input | not_allowed | no_booking | not_confirmed | past_close |
--           therapist_busy | room_busy | centre_full | busy
-- =====================================================================
create or replace function public.assign_room(p_booking_id uuid, p_room int)
returns text
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare b record; v_rooms int;
begin
  select * into b from public.bookings where id = p_booking_id and kind = 'booking';
  if not found or not private.staff_ok(b.tenant_id, b.branch_id) then return 'no_booking'; end if;

  if p_room is null then
    update public.bookings set room_no = null where id = p_booking_id;
    return 'ok';
  end if;
  if b.status <> 'confirmed' then return 'not_confirmed'; end if;
  select rooms into v_rooms from public.branches where id = b.branch_id;
  if p_room < 1 or p_room > v_rooms then return 'no_such_room'; end if;

  update public.bookings set room_no = p_room where id = p_booking_id;
  return 'ok';
exception when exclusion_violation then
  return 'busy';
end $$;

create or replace function public.adjust_session(p_booking_id uuid, p_duration int, p_price int)
returns text
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  b public.bookings%rowtype; br public.branches%rowtype;
  v_buf int; v_new_end int; v_who text; v_on_menu boolean;
begin
  if auth.uid() is null then return 'no_booking'; end if;
  select * into b from public.bookings where id = p_booking_id and kind = 'booking';
  if not found or not private.staff_ok(b.tenant_id, b.branch_id) then return 'no_booking'; end if;
  if p_duration is null or p_price is null then return 'bad_input'; end if;

  select * into b from public.bookings where id = p_booking_id for update;
  if b.status <> 'confirmed' then return 'not_confirmed'; end if;
  if p_duration = b.duration and p_price = b.price then return 'no_change'; end if;

  select * into br from public.branches where id = b.branch_id;
  select exists (
    select 1 from public.services s join public.service_options so on so.service_id = s.id
     where s.menu_id = br.menu_id and s.code = b.service_id and s.active
       and so.active and so.duration_min = p_duration and so.price = p_price) into v_on_menu;

  if not v_on_menu then
    if not private.is_manager(b.tenant_id) then return 'not_allowed'; end if;
    if p_duration < 15 or p_duration > 240 or p_price < 0 or p_price > 100000 then return 'bad_input'; end if;
  end if;

  v_new_end := b.start_min + p_duration;
  if v_new_end > br.close_min then return 'past_close'; end if;
  select buffer_mins into v_buf from public.tenants where id = b.tenant_id;

  if b.therapist_id is not null and exists (
       select 1 from public.bookings x
        where x.id <> b.id and x.therapist_id = b.therapist_id and x.date = b.date
          and x.kind = 'booking' and x.status = 'confirmed'
          and x.start_min < v_new_end and x.end_min > b.start_min) then
    return 'therapist_busy';
  end if;

  if b.room_no is not null and exists (
       select 1 from public.bookings x
        where x.id <> b.id and x.branch_id = b.branch_id and x.date = b.date and x.room_no = b.room_no
          and x.status = 'confirmed'
          and x.start_min < v_new_end + v_buf and x.block_end_min > b.start_min) then
    return 'room_busy';
  end if;

  select u.email into v_who from auth.users u where u.id = auth.uid();

  update public.bookings set
      orig_duration = coalesce(orig_duration, duration),
      orig_price    = coalesce(orig_price, price),
      duration      = p_duration,
      price         = p_price,
      end_min       = v_new_end,
      service_name  = regexp_replace(service_name, '\(\d+ Mins\)\s*$', '(' || p_duration || ' Mins)'),
      adjusted_at   = now(),
      adjusted_by   = coalesce(v_who, 'staff')
   where id = p_booking_id;
  return 'ok';
exception
  when exclusion_violation then return 'busy';
  when sqlstate 'CF001' then return 'centre_full';
end $$;

revoke all on function public.assign_room(uuid, int), public.adjust_session(uuid, int, int) from public, anon;
grant execute on function public.assign_room(uuid, int), public.adjust_session(uuid, int, int) to authenticated;
