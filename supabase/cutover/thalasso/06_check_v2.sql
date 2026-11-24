-- =====================================================================
-- THALASSO CUT-OVER  step 6 of 7  ·  CHECK THE NEW DATABASE (NEW project, after 05_import_v2.sql). READ-ONLY.
-- Compare with the old database: run the "old side" query at the bottom there and the numbers must be identical.
-- =====================================================================
with t as (select id from public.tenants where slug = 'thalasso')
select 'bookings per branch / status' as what, b.loc_id || ' / ' || b.status as detail, count(*)::text as value
  from public.bookings b, t where b.tenant_id = t.id group by 1, 2
union all select 'confirmed revenue (price + add-ons)', '', coalesce(sum(b.price + b.addon_amt), 0)::text
  from public.bookings b, t where b.tenant_id = t.id and b.status = 'confirmed'
union all select 'therapists per branch', th.loc_id, count(*)::text
  from public.therapists th, t where th.tenant_id = t.id group by th.loc_id
union all select 'roster days', '', count(*)::text from public.therapist_days d, t where d.tenant_id = t.id
union all select 'bookings with a therapist assigned', '', count(*)::text
  from public.bookings b, t where b.tenant_id = t.id and b.therapist_id is not null
union all select 'bookings without a room (OK: assign in the console)', '', count(*)::text
  from public.bookings b, t where b.tenant_id = t.id and b.room_no is null and b.status = 'confirmed'
union all select 'earliest / latest booking date', '', min(b.date)::text || ' / ' || max(b.date)::text
  from public.bookings b, t where b.tenant_id = t.id
union all select 'Thalasso switched on for guests?', '', (select active::text from public.tenants where slug = 'thalasso')
order by 1, 2;

/* ---- OLD side (run in the OLD Thalasso project; the numbers must match the rows above) ----
select loc_id || ' / ' || status as detail, count(*) from public.bookings where kind = 'booking' group by 1 order by 1;
select coalesce(sum(price + addon_amt), 0) as confirmed_revenue from public.bookings where kind = 'booking' and status = 'confirmed';
select loc_id, count(*) from public.therapists group by 1 order by 1;
select count(*) as roster_days from public.therapist_days;
select count(*) as with_therapist from public.bookings where kind = 'booking' and therapist_id is not null;
*/
