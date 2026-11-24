-- =====================================================================
-- THALASSO CUT-OVER  step 5 of 7  ·  IMPORT (NEW shared project)
-- Run AFTER you pasted step 3's cell into this project (it lands in private.cutover_stage) and AFTER 04_prepare_v2.sql.
-- ONE transaction: if anything is wrong the whole import is rolled back and nothing is left half-copied.
--   * every therapist, roster day and booking keeps its ORIGINAL id and creation time, so every
--     "booking -> therapist" link survives
--   * refuses to run if Thalasso already has bookings / therapists here (it can only run once)
--   * checks the copy against the control totals from the old database (counts, revenue, therapist links, per branch
--     and status) and aborts on any difference
--   * AUTO-FIXES, listed in the report: duplicate references (-2, -3 ...), past room clashes (room cleared),
--     add-on text missing / too long
--   * the overbooking rule is paused only while copying, then every future day is checked against the room count
--   * switches Thalasso ON at the end (nothing changes for guests until you publish the new website)
-- Result: one row, the report (also saved in private.cutover_log).
-- =====================================================================
do $import$
declare
  v_tenant public.tenants%rowtype;
  v_doc jsonb; v_ctl jsonb; v_today date;
  r_th public.therapists%rowtype; r_td public.therapist_days%rowtype; r public.bookings%rowtype;
  v_branch public.branches%rowtype;
  n_th int := 0; n_td int := 0; n_bk int := 0;
  fix_refs int := 0; fix_rooms int := 0; fix_addon_text int := 0; fix_addon_cut int := 0; fix_locname int := 0;
  v_try int; v_base text; v_bad int; v_report jsonb; v_want int; v_got int;
begin
  select * into v_tenant from public.tenants where slug = 'thalasso';
  if not found then raise exception 'Tenant thalasso is not in this database: run supabase/seed/thalasso.sql first'; end if;
  if exists (select 1 from public.bookings where tenant_id = v_tenant.id)
     or exists (select 1 from public.therapists where tenant_id = v_tenant.id) then
    raise exception 'Thalasso already has bookings or therapists here: the import already ran (or this is the wrong project). Nothing was changed.';
  end if;
  select doc into v_doc from private.cutover_stage order by id desc limit 1;
  if v_doc is null then raise exception 'Nothing to import: paste step 3''s cell into this project first'; end if;
  v_ctl := v_doc -> 'control';
  v_today := (now() at time zone v_tenant.timezone)::date;

  alter table public.bookings disable trigger bookings_capacity;      -- paused for the copy; checked below

  for r_th in select * from jsonb_populate_recordset(null::public.therapists, v_doc -> 'therapists') order by created_at, id loop
    r_th.tenant_id := v_tenant.id;
    insert into public.therapists select r_th.*;
    n_th := n_th + 1;
  end loop;

  for r_td in select * from jsonb_populate_recordset(null::public.therapist_days, v_doc -> 'therapist_days')
              order by date, loc_id, seq, created_at, id loop
    r_td.tenant_id := v_tenant.id;                                     -- branch and seq are filled in by the roster trigger
    insert into public.therapist_days select r_td.*;
    n_td := n_td + 1;
  end loop;

  for r in select * from jsonb_populate_recordset(null::public.bookings, v_doc -> 'bookings')
           order by date, start_min, created_at, id loop
    select * into v_branch from public.branches where tenant_id = v_tenant.id and code = r.loc_id;
    if not found then raise exception 'Booking % is at branch "%" which does not exist in the new database', r.ref, r.loc_id; end if;
    r.tenant_id := v_tenant.id; r.branch_id := v_branch.id; r.block_end_min := null;   -- block_end_min comes from the trigger
    r.updated_at := r.created_at;                                      -- unchanged since the old database
    if r.loc_name is null or trim(r.loc_name) = '' then r.loc_name := v_branch.name; fix_locname := fix_locname + 1; end if;
    if r.addon_amt > 0 and (r.addon_text is null or trim(r.addon_text) = '') then r.addon_text := 'Add-on'; fix_addon_text := fix_addon_text + 1; end if;
    if length(r.addon_text) > 80 then r.addon_text := left(r.addon_text, 80); fix_addon_cut := fix_addon_cut + 1; end if;
    if r.addon_text is not null and trim(r.addon_text) = '' then r.addon_text := null; end if;
    -- new columns added in migration 0015; old Thalasso data has no value for them
    if r.payment_method is null then r.payment_method := 'pending'; end if;
    if r.discount_amt    is null then r.discount_amt   := 0;         end if;

    if r.ref is not null and exists (select 1 from public.bookings where tenant_id = v_tenant.id and ref = r.ref) then
      v_base := r.ref; v_try := 2;
      while exists (select 1 from public.bookings where tenant_id = v_tenant.id and ref = v_base || '-' || v_try) loop v_try := v_try + 1; end loop;
      r.ref := v_base || '-' || v_try; fix_refs := fix_refs + 1;
    end if;

    begin
      insert into public.bookings select r.*;
    exception when exclusion_violation then
      if r.date < v_today and r.room_no is not null then              -- past clash (cleaning gap was not enforced before)
        r.room_no := null; fix_rooms := fix_rooms + 1;
        insert into public.bookings select r.*;                        -- fails again only for a therapist clash: abort
      else
        raise;
      end if;
    end;
    n_bk := n_bk + 1;
  end loop;

  alter table public.bookings enable trigger bookings_capacity;

  -- ---- verification against the control totals taken from the old database (any difference aborts everything) ----
  if n_th <> (v_ctl ->> 'therapists')::int or n_td <> (v_ctl ->> 'therapist_days')::int or n_bk <> (v_ctl ->> 'bookings')::int then
    raise exception 'Row counts differ: copied % therapists / % roster days / % bookings, old database had % / % / %',
      n_th, n_td, n_bk, v_ctl ->> 'therapists', v_ctl ->> 'therapist_days', v_ctl ->> 'bookings';
  end if;
  select coalesce(sum(price + addon_amt), 0) into v_got from public.bookings where tenant_id = v_tenant.id and status = 'confirmed';
  if v_got <> (v_ctl ->> 'confirmed_revenue')::int then
    raise exception 'Confirmed revenue differs: new % vs old %', v_got, v_ctl ->> 'confirmed_revenue';
  end if;
  select count(*) into v_got from public.bookings where tenant_id = v_tenant.id and therapist_id is not null;
  if v_got <> (v_ctl ->> 'with_therapist')::int then
    raise exception 'Bookings with a therapist differ: new % vs old %', v_got, v_ctl ->> 'with_therapist';
  end if;
  select count(*) into v_bad from (
    select k, n from jsonb_each_text(v_ctl -> 'by_branch_status') e(k, n)
    full join (select loc_id || '/' || status as k2, count(*)::text as n2 from public.bookings
                where tenant_id = v_tenant.id group by 1) z on z.k2 = e.k
    where e.n is distinct from z.n2) d;
  if v_bad > 0 then raise exception 'Booking counts per branch and status differ from the old database (% groups)', v_bad; end if;
  select count(*) into v_bad from public.bookings b join public.therapists t on t.id = b.therapist_id
   where b.tenant_id = v_tenant.id and t.tenant_id <> v_tenant.id;
  if v_bad > 0 then raise exception 'A booking points at a therapist of another business'; end if;

  -- ---- overbooking: from today on, never more bookings running at once than the branch has rooms ----
  select count(*) into v_bad from (
    select b.id from public.bookings b join public.branches br on br.id = b.branch_id
     where b.tenant_id = v_tenant.id and b.status = 'confirmed' and b.date >= v_today
       and (select count(*) from public.bookings y
             where y.branch_id = b.branch_id and y.date = b.date and y.status = 'confirmed'
               and y.start_min <= b.start_min and y.block_end_min > b.start_min) > br.rooms) d;
  if v_bad > 0 then
    raise exception 'Today or later, % booking time(s) have more guests than rooms (cleaning gap included). Staff must move a booking in the OLD system, then re-run steps 3 to 5.', v_bad;
  end if;

  update public.tenants set active = true where id = v_tenant.id;

  v_report := jsonb_build_object(
    'copied', jsonb_build_object('therapists', n_th, 'roster_days', n_td, 'bookings', n_bk),
    'auto_fixed', jsonb_build_object('duplicate_references_renamed', fix_refs, 'past_room_clashes_room_cleared', fix_rooms,
                  'addon_text_added', fix_addon_text, 'addon_text_cut_to_80', fix_addon_cut, 'branch_name_filled', fix_locname),
    'control_totals_match', jsonb_build_object('counts', true, 'confirmed_revenue', v_ctl -> 'confirmed_revenue',
                  'bookings_with_therapist', v_ctl -> 'with_therapist', 'by_branch_status', v_ctl -> 'by_branch_status'),
    'imported_at', now());
  insert into private.cutover_log (tenant_slug, cutover_at, report) values ('thalasso', now(), v_report);
  raise notice 'THALASSO IMPORT OK: %', v_report;
end
$import$;

-- the report (also stored in private.cutover_log)
select report from private.cutover_log where tenant_slug = 'thalasso' order by id desc limit 1;

