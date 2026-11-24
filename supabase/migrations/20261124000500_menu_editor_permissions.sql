-- =====================================================================
-- 0013  Menu editor, part 1: permissions
--   Owners / managers add treatments and durations through the functions in 0014 (which validate everything).
--   Direct table writes are narrowed so those checks cannot be bypassed and nothing can be deleted:
--     * no deleting menus, branches, treatments or durations (switch them off instead)
--     * no inserting treatments or durations straight into the tables
--     * on treatments no direct updates at all; on durations only price / on-off / sort (what the price grid saves)
--   services.edited_in_ui: set when a treatment is renamed / re-described in the browser, so that re-running a
--   seed file never overwrites what the owner changed.
-- =====================================================================
alter table public.services add column edited_in_ui boolean not null default false;

revoke delete on public.menus, public.branches, public.services, public.service_options from authenticated;
revoke insert, update on public.services from authenticated;
revoke insert, update on public.service_options from authenticated;
grant update (price, active, sort) on public.service_options to authenticated;

-- the unique name rule is enforced by the functions (case-insensitive, per menu); this index backs it up
create unique index services_menu_name_uq on public.services (menu_id, lower(name));
