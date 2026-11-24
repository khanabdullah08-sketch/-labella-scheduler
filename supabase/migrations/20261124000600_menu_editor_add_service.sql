-- =====================================================================
-- 0014  Menu editor, part 2: add a treatment (with its durations and prices) to one or more menus.
--   manager_add_service(menus, category, name, description, options)
--     options = [{"duration": 60, "price": 2500}, ...]
--   Only an owner / manager of the caller's own business. Everything is validated BEFORE anything is written, so a
--   refused request changes nothing. The treatment code (u + 8 hex characters) is made by the database.
--   Result: {"status":"ok","count":n,"codes":[...]}  or  {"status":"<code>"} where code is one of
--   forbidden | badname | badcategory | baddescription | invalid_menu | badoptions | badduration | badprice |
--   dupduration | dupname | toolong
-- =====================================================================
create or replace function public.manager_add_service(
  p_menus text[], p_category text, p_name text, p_description text, p_options jsonb)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := private.my_tenant();
  v_cat  text := regexp_replace(trim(coalesce(p_category, '')), '\s+', ' ', 'g');
  v_name text := regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_desc text := trim(coalesce(p_description, ''));
  v_codes text[]; v_opt jsonb; v_dur int; v_maxdur int := 0; v_seen int[] := '{}';
  m record; v_found int := 0; v_span int; v_sid uuid; v_code text; v_sort int; v_out text[] := '{}';
begin
  if auth.uid() is null or v_tenant is null or not private.is_manager(v_tenant) then
    return jsonb_build_object('status', 'forbidden');
  end if;
  if length(v_name) not between 2 and 80  then return jsonb_build_object('status', 'badname'); end if;
  if length(v_cat)  not between 2 and 40  then return jsonb_build_object('status', 'badcategory'); end if;
  if length(v_desc) > 300                 then return jsonb_build_object('status', 'baddescription'); end if;
  if p_menus is null or cardinality(p_menus) = 0 then return jsonb_build_object('status', 'invalid_menu'); end if;
  select coalesce(array_agg(distinct x), '{}') into v_codes from unnest(p_menus) x;
  if cardinality(v_codes) > 10 then return jsonb_build_object('status', 'invalid_menu'); end if;
  if p_options is null or jsonb_typeof(p_options) <> 'array' or jsonb_array_length(p_options) not between 1 and 10 then
    return jsonb_build_object('status', 'badoptions');
  end if;

  for v_opt in select * from jsonb_array_elements(p_options) loop
    if jsonb_typeof(v_opt) <> 'object' or jsonb_typeof(v_opt -> 'duration') <> 'number'
       or jsonb_typeof(v_opt -> 'price') <> 'number' then
      return jsonb_build_object('status', 'badoptions');
    end if;
    if (v_opt ->> 'duration') !~ '^[0-9]{1,3}$' then return jsonb_build_object('status', 'badduration'); end if;
    if (v_opt ->> 'price')    !~ '^[0-9]{1,7}$' then return jsonb_build_object('status', 'badprice'); end if;
    v_dur := (v_opt ->> 'duration')::int;
    if v_dur not between 5 and 480 then return jsonb_build_object('status', 'badduration'); end if;
    if (v_opt ->> 'price')::int not between 1 and 1000000 then return jsonb_build_object('status', 'badprice'); end if;
    if v_dur = any (v_seen) then return jsonb_build_object('status', 'dupduration'); end if;
    v_seen := v_seen || v_dur;
    v_maxdur := greatest(v_maxdur, v_dur);
  end loop;

  -- every menu must be this business's own, free of a same-named treatment, and open long enough
  for m in select mn.id, mn.code from public.menus mn where mn.tenant_id = v_tenant and mn.code = any (v_codes) loop
    v_found := v_found + 1;
    if exists (select 1 from public.services s where s.menu_id = m.id and lower(s.name) = lower(v_name)) then
      return jsonb_build_object('status', 'dupname');
    end if;
    select coalesce(max(b.close_min - b.open_min), 0) into v_span from public.branches b where b.menu_id = m.id and b.active;
    if v_span > 0 and v_maxdur > v_span then return jsonb_build_object('status', 'toolong'); end if;
  end loop;
  if v_found <> cardinality(v_codes) then return jsonb_build_object('status', 'invalid_menu'); end if;

  for m in select mn.id from public.menus mn where mn.tenant_id = v_tenant and mn.code = any (v_codes) order by mn.code loop
    loop
      v_code := 'u' || substr(md5(gen_random_uuid()::text), 1, 8);
      exit when not exists (select 1 from public.services where tenant_id = v_tenant and code = v_code);
    end loop;
    select coalesce(max(s.sort), -1) + 1 into v_sort from public.services s where s.menu_id = m.id;
    insert into public.services (tenant_id, menu_id, code, category, name, description, sort, edited_in_ui)
    values (v_tenant, m.id, v_code, v_cat, v_name, v_desc, v_sort, true) returning id into v_sid;
    insert into public.service_options (tenant_id, service_id, duration_min, price, sort)
    select v_tenant, v_sid, (e ->> 'duration')::int, (e ->> 'price')::int, (ord - 1)::int
      from jsonb_array_elements(p_options) with ordinality as t(e, ord);
    v_out := v_out || v_code;
  end loop;
  return jsonb_build_object('status', 'ok', 'count', cardinality(v_out), 'codes', to_jsonb(v_out));
end $$;

revoke all on function public.manager_add_service(text[], text, text, text, jsonb) from public, anon;
grant execute on function public.manager_add_service(text[], text, text, text, jsonb) to authenticated;
