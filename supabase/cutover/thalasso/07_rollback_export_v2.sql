-- =====================================================================
-- THALASSO CUT-OVER  step 7  ·  ROLLBACK (keep possible for 48 hours after cut-over)
-- Use ONLY if the new system must be abandoned. Run in the NEW project: it returns ONE cell — a complete SQL
-- script — containing every Thalasso booking, therapist and roster row that was CREATED OR CHANGED after the import.
-- Then, in the OLD project, run in this order:
--   1. 02b_unfreeze_legacy.sql      (the old database accepts changes again)
--   2. the cell from this script    (copies the new changes back: inserts new rows, updates changed ones by id)
--   3. in Netlify: set BACKEND back to "legacy" is NOT needed — republish the PREVIOUS deploy (Deploys > the last
--      deploy before cut-over > "Publish deploy") and set SUPABASE_URL / SUPABASE_ANON_KEY back to the OLD project.
-- Columns that only exist in the old database are filled in as the old system expects them.
-- =====================================================================
with t as (select id from public.tenants where slug = 'thalasso'),
since as (select max(cutover_at) as at from private.cutover_log where tenant_slug = 'thalasso'),
b as (select x.* from public.bookings x, t, since where x.tenant_id = t.id and x.kind = 'booking' and x.updated_at > since.at),
th as (select x.* from public.therapists x, t, since where x.tenant_id = t.id and x.created_at > since.at),
td as (select x.* from public.therapist_days x, t, since where x.tenant_id = t.id and x.created_at > since.at),
doc as (
  select jsonb_build_object(
    'bookings', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'created_at', created_at, 'kind', kind, 'status', status, 'ref', ref,
        'loc_id', loc_id, 'loc_name', loc_name, 'service_id', service_id, 'service_name', service_name, 'duration', duration, 'price', price,
        'date', date, 'start_min', start_min, 'end_min', end_min, 'room_no', room_no, 'name', name, 'phone', phone, 'notes', notes,
        'source', source, 'created_by', created_by, 'therapist_id', therapist_id, 'therapist_name', therapist_name, 'addon_text', addon_text,
        'addon_amt', addon_amt, 'orig_duration', orig_duration, 'orig_price', orig_price, 'adjusted_at', adjusted_at, 'adjusted_by', adjusted_by)) from b), '[]'::jsonb),
    'therapists', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'loc_id', loc_id, 'name', name, 'active', active, 'created_at', created_at)) from th), '[]'::jsonb),
    'therapist_days', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'therapist_id', therapist_id, 'loc_id', loc_id, 'date', date,
        'arrival_min', arrival_min, 'shift_end_min', shift_end_min, 'on_leave', on_leave, 'seq', seq, 'created_at', created_at)) from td), '[]'::jsonb)
  ) as j
)
select
 'do $rb$ declare d jsonb := ' || quote_literal(j::text) || '::jsonb; begin '
 || 'insert into public.therapists select * from jsonb_populate_recordset(null::public.therapists, d->''therapists'') on conflict (id) do update set name = excluded.name, active = excluded.active; '
 || 'insert into public.therapist_days select * from jsonb_populate_recordset(null::public.therapist_days, d->''therapist_days'') on conflict (id) do update set arrival_min = excluded.arrival_min, shift_end_min = excluded.shift_end_min, on_leave = excluded.on_leave; '
 || 'insert into public.bookings select * from jsonb_populate_recordset(null::public.bookings, d->''bookings'') on conflict (id) do update set status = excluded.status, room_no = excluded.room_no, '
 || 'therapist_id = excluded.therapist_id, therapist_name = excluded.therapist_name, duration = excluded.duration, price = excluded.price, end_min = excluded.end_min, service_name = excluded.service_name, '
 || 'addon_text = excluded.addon_text, addon_amt = excluded.addon_amt, orig_duration = excluded.orig_duration, orig_price = excluded.orig_price, adjusted_at = excluded.adjusted_at, adjusted_by = excluded.adjusted_by, notes = excluded.notes; '
 || 'end $rb$;' as copy_this_cell_into_the_old_project,
 (jsonb_array_length(j -> 'bookings')) as bookings_to_copy_back,
 (jsonb_array_length(j -> 'therapists')) as therapists_to_copy_back,
 (jsonb_array_length(j -> 'therapist_days')) as roster_days_to_copy_back
from doc;
