-- =====================================================================
-- 0004  Triggers: values the browser must never be able to choose.
-- =====================================================================

-- block_end_min always derives from the tenant's cleaning buffer.
create or replace function private.bookings_set_block()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  select new.end_min + t.buffer_mins into new.block_end_min
    from public.tenants t where t.id = new.tenant_id;
  if new.block_end_min is null then
    raise exception 'Unknown tenant for booking';
  end if;
  return new;
end $$;

create trigger bookings_set_block
  before insert or update of start_min, end_min, tenant_id on public.bookings
  for each row execute function private.bookings_set_block();

-- Roster rows: tenant comes from the logged-in staff member (never from the browser),
-- branch comes from the branch code, and the per-branch/day therapist cap is enforced.
create or replace function private.roster_fill()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_tenant uuid; v_cap int; v_n int;
begin
  v_tenant := private.my_tenant();
  if v_tenant is not null then new.tenant_id := v_tenant; end if;   -- staff session: forced
  if new.tenant_id is null then raise exception 'No tenant for this change'; end if;

  select b.id into new.branch_id from public.branches b
   where b.tenant_id = new.tenant_id and b.code = new.loc_id;
  if new.branch_id is null then raise exception 'Unknown branch: %', new.loc_id; end if;

  if tg_table_name = 'therapist_days' then
    if not exists (select 1 from public.therapists th
                    where th.id = new.therapist_id and th.branch_id = new.branch_id) then
      raise exception 'Therapist does not belong to this branch';
    end if;
    perform pg_advisory_xact_lock(hashtextextended(new.branch_id::text || new.date::text, 0));
    select t.therapist_daily_cap into v_cap from public.tenants t where t.id = new.tenant_id;
    select count(*) into v_n from public.therapist_days d
     where d.branch_id = new.branch_id and d.date = new.date;
    if v_n >= v_cap then
      raise exception 'Limit reached: % therapists per branch per day', v_cap;
    end if;
    new.seq := v_n + 1;
  end if;
  return new;
end $$;

create trigger therapists_fill     before insert on public.therapists
  for each row execute function private.roster_fill();
create trigger therapist_days_fill before insert on public.therapist_days
  for each row execute function private.roster_fill();

-- Shift end must be after arrival.
alter table public.therapist_days add constraint therapist_days_shift_order
  check (shift_end_min is null or shift_end_min > arrival_min);
