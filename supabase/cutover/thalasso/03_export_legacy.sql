-- =====================================================================
-- THALASSO CUT-OVER  step 3 of 7  ·  EXPORT (OLD Thalasso project, AFTER 02_freeze_legacy.sql)
-- READ-ONLY. Returns ONE cell. Copy that cell (it is a complete SQL statement that carries every therapist, roster
-- day and booking, plus control totals) and run it in the NEW (shared) project's SQL Editor — see step 5.
-- Temporary holds (kind = 'hold') are deliberately not copied.
-- If the cell is too large to copy from the grid, use "Download CSV" and paste the cell value.
-- =====================================================================
with b as (select * from public.bookings where kind = 'booking'),
doc as (
  select jsonb_build_object(
    'exported_at', now(),
    'therapists', coalesce((select jsonb_agg(to_jsonb(t) order by t.created_at, t.id) from public.therapists t), '[]'::jsonb),
    'therapist_days', coalesce((select jsonb_agg(to_jsonb(d) order by d.date, d.loc_id, d.seq, d.created_at, d.id) from public.therapist_days d), '[]'::jsonb),
    'bookings', coalesce((select jsonb_agg(to_jsonb(x) order by x.date, x.start_min, x.created_at, x.id) from b x), '[]'::jsonb),
    'control', jsonb_build_object(
      'therapists',     (select count(*) from public.therapists),
      'therapist_days', (select count(*) from public.therapist_days),
      'bookings',       (select count(*) from b),
      'confirmed_revenue', (select coalesce(sum(price + addon_amt), 0) from b where status = 'confirmed'),
      'with_therapist', (select count(*) from b where therapist_id is not null),
      'by_branch_status', (select coalesce(jsonb_object_agg(k, n), '{}'::jsonb)
                             from (select loc_id || '/' || status as k, count(*) as n from b group by 1) z))
  ) as j
)
select 'create schema if not exists private; '
    || 'create table if not exists private.cutover_stage (id bigserial primary key, loaded_at timestamptz not null default now(), doc jsonb not null); '
    || 'insert into private.cutover_stage (doc) values (' || quote_literal(j::text) || '::jsonb);' as copy_this_cell_into_the_new_project
from doc;
