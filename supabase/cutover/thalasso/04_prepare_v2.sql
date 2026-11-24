-- =====================================================================
-- THALASSO CUT-OVER  step 4 of 7  ·  PREPARE THE NEW (shared) PROJECT  — do this days BEFORE cut-over night
-- Run in the NEW project's SQL Editor AFTER: all migrations (up to 20261124000700) and supabase/seed/thalasso.sql.
-- 1. Thalasso is switched OFF, so guests cannot see or book it in the new database yet.
-- 2. A log table remembers when the import happened (the rollback script needs it).
-- Staff logins for Thalasso are created separately (see 04b_staff_template.sql).
-- =====================================================================
update public.tenants set active = false where slug = 'thalasso';

create schema if not exists private;
create table if not exists private.cutover_log (
  id          bigserial primary key,
  tenant_slug text not null,
  cutover_at  timestamptz not null,
  report      jsonb not null
);
create table if not exists private.cutover_stage (
  id        bigserial primary key,
  loaded_at timestamptz not null default now(),
  doc       jsonb not null
);

-- sanity: the seed must be there, with nothing booked yet
select t.slug, t.active,
       (select count(*) from public.branches b where b.tenant_id = t.id) as branches,
       (select count(*) from public.services s where s.tenant_id = t.id) as treatments,
       (select count(*) from public.bookings x where x.tenant_id = t.id) as bookings_already_here
  from public.tenants t where t.slug = 'thalasso';
