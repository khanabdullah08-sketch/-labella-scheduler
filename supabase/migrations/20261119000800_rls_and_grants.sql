-- =====================================================================
-- 0008  Row Level Security + grants.
--  * Website visitors (anon): NO table access at all. They can only call the booking functions.
--  * Staff (authenticated): only rows of their own tenant and branches.
--  * Only owners/managers can edit menus, branches and prices.
-- (Also: turn OFF "Allow new users to sign up" in Supabase Auth settings; staff are invited.)
-- =====================================================================

-- Start from zero, then grant back exactly what is needed.
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on functions from public, anon, authenticated;

alter table public.tenants         enable row level security;
alter table public.menus           enable row level security;
alter table public.branches        enable row level security;
alter table public.services        enable row level security;
alter table public.service_options enable row level security;
alter table public.staff           enable row level security;
alter table public.therapists      enable row level security;
alter table public.therapist_days  enable row level security;
alter table public.bookings        enable row level security;

-- policy helpers are callable by logged-in users (RLS runs them as the caller)
grant usage on schema private to authenticated;
grant execute on function private.staff_ok(uuid, uuid), private.my_tenant(), private.is_manager(uuid) to authenticated;

-- ---- catalog: staff read their tenant; owners/managers write ------------------------------
grant select, insert, update, delete on public.menus, public.branches, public.services, public.service_options to authenticated;
grant select, update on public.tenants to authenticated;
grant select on public.staff to authenticated;

create policy tenants_read  on public.tenants for select to authenticated using (private.staff_ok(id));
create policy tenants_write on public.tenants for update to authenticated
  using (private.is_manager(id)) with check (private.is_manager(id));

create policy staff_read_self on public.staff for select to authenticated using (user_id = auth.uid());

create policy menus_read  on public.menus for select to authenticated using (private.staff_ok(tenant_id));
create policy menus_write on public.menus for all to authenticated
  using (private.is_manager(tenant_id)) with check (private.is_manager(tenant_id));

create policy branches_read  on public.branches for select to authenticated using (private.staff_ok(tenant_id));
create policy branches_write on public.branches for all to authenticated
  using (private.is_manager(tenant_id)) with check (private.is_manager(tenant_id));

create policy services_read  on public.services for select to authenticated using (private.staff_ok(tenant_id));
create policy services_write on public.services for all to authenticated
  using (private.is_manager(tenant_id)) with check (private.is_manager(tenant_id));

create policy options_read  on public.service_options for select to authenticated using (private.staff_ok(tenant_id));
create policy options_write on public.service_options for all to authenticated
  using (private.is_manager(tenant_id)) with check (private.is_manager(tenant_id));

-- ---- operations: any staff member, but only for their own branches ------------------------
grant select, update (status) on public.bookings to authenticated;   -- create via functions; edit status only
create policy bookings_read   on public.bookings for select to authenticated
  using (kind = 'booking' and private.staff_ok(tenant_id, branch_id));
create policy bookings_status on public.bookings for update to authenticated
  using (kind = 'booking' and private.staff_ok(tenant_id, branch_id))
  with check (private.staff_ok(tenant_id, branch_id));

grant select, insert, update (active, name) on public.therapists to authenticated;
create policy therapists_read   on public.therapists for select to authenticated using (private.staff_ok(tenant_id, branch_id));
create policy therapists_insert on public.therapists for insert to authenticated with check (private.staff_ok(tenant_id, branch_id));
create policy therapists_update on public.therapists for update to authenticated
  using (private.staff_ok(tenant_id, branch_id)) with check (private.staff_ok(tenant_id, branch_id));

grant select, insert, delete, update (on_leave, shift_end_min, arrival_min) on public.therapist_days to authenticated;
create policy tdays_read   on public.therapist_days for select to authenticated using (private.staff_ok(tenant_id, branch_id));
create policy tdays_insert on public.therapist_days for insert to authenticated with check (private.staff_ok(tenant_id, branch_id));
create policy tdays_update on public.therapist_days for update to authenticated
  using (private.staff_ok(tenant_id, branch_id)) with check (private.staff_ok(tenant_id, branch_id));
create policy tdays_delete on public.therapist_days for delete to authenticated using (private.staff_ok(tenant_id, branch_id));

-- ---- functions: public booking API for everyone, staff API for logged-in users only -------
grant execute on function
  public.get_catalog(text),
  public.get_busy_v2(text, text, date, text),
  public.create_hold_v2(text, text, date, int, text, int, text, int),
  public.confirm_booking_v2(text, text, text, text, text),
  public.release_hold(text)
to anon, authenticated;

grant execute on function
  public.staff_create_booking(text, text, int, date, int, text, text, text, text),
  public.assign_therapist(uuid, uuid),
  public.end_shift(uuid, boolean)
to authenticated;
