-- =====================================================================
-- 0015  Menu editor, part 3: add a duration to an existing treatment, and edit a treatment's details.
--   manager_add_option(treatment, duration, price)   -> ok | forbidden | not_found | badduration | badprice | dupduration | toolong
--   manager_update_service(treatment, category, name, description, active)
--                                                     -> ok | forbidden | not_found | badname | badcategory | baddescription | dupname
--   Owner / manager of the caller's own business only. A treatment that is switched off disappears from the booking page
--   and the walk-in form but keeps its history (bookings store their own copy of the name and price).
-- =====================================================================
create or replace function public.manager_add_option(p_service uuid, p_duration int, p_price int)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := private.my_tenant();
  s public.services%rowtype; v_span int; v_sort int; v_id uuid;
begin
  if auth.uid() is null or v_tenant is null or not private.is_manager(v_tenant) then
    return jsonb_build_object('status', 'forbidden');
  end if;
  select * into s from public.services where id = p_service and tenant_id = v_tenant;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if p_duration is null or p_duration not between 5 and 480 then return jsonb_build_object('status', 'badduration'); end if;
  if p_price is null or p_price not between 1 and 1000000 then return jsonb_build_object('status', 'badprice'); end if;
  if exists (select 1 from public.service_options o where o.service_id = s.id and o.duration_min = p_duration) then
    return jsonb_build_object('status', 'dupduration');      -- already there (it may be switched off: tick Active instead)
  end if;
  select coalesce(max(b.close_min - b.open_min), 0) into v_span from public.branches b where b.menu_id = s.menu_id and b.active;
  if v_span > 0 and p_duration > v_span then return jsonb_build_object('status', 'toolong'); end if;
  select coalesce(max(o.sort), -1) + 1 into v_sort from public.service_options o where o.service_id = s.id;
  insert into public.service_options (tenant_id, service_id, duration_min, price, sort)
  values (v_tenant, s.id, p_duration, p_price, v_sort) returning id into v_id;
  return jsonb_build_object('status', 'ok', 'id', v_id);
end $$;

create or replace function public.manager_update_service(
  p_service uuid, p_category text, p_name text, p_description text, p_active boolean)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := private.my_tenant();
  v_cat  text := regexp_replace(trim(coalesce(p_category, '')), '\s+', ' ', 'g');
  v_name text := regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_desc text := trim(coalesce(p_description, ''));
  s public.services%rowtype;
begin
  if auth.uid() is null or v_tenant is null or not private.is_manager(v_tenant) then
    return jsonb_build_object('status', 'forbidden');
  end if;
  select * into s from public.services where id = p_service and tenant_id = v_tenant;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if length(v_name) not between 2 and 80 then return jsonb_build_object('status', 'badname'); end if;
  if length(v_cat)  not between 2 and 40 then return jsonb_build_object('status', 'badcategory'); end if;
  if length(v_desc) > 300                then return jsonb_build_object('status', 'baddescription'); end if;
  if p_active is null                    then return jsonb_build_object('status', 'badname'); end if;
  if exists (select 1 from public.services x where x.menu_id = s.menu_id and x.id <> s.id and lower(x.name) = lower(v_name)) then
    return jsonb_build_object('status', 'dupname');
  end if;
  update public.services
     set category = v_cat, name = v_name, description = v_desc, active = p_active, edited_in_ui = true
   where id = s.id;
  return jsonb_build_object('status', 'ok');
end $$;

revoke all on function public.manager_add_option(uuid, int, int) from public, anon;
revoke all on function public.manager_update_service(uuid, text, text, text, boolean) from public, anon;
grant execute on function public.manager_add_option(uuid, int, int), public.manager_update_service(uuid, text, text, text, boolean) to authenticated;
