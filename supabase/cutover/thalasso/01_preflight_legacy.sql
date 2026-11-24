-- =====================================================================
-- THALASSO CUT-OVER  step 1 of 7  ·  PRE-FLIGHT REPORT
-- Run in the OLD Thalasso Supabase project (SQL Editor). READ-ONLY: nothing is changed.
--   "MUST FIX"    problems have to be 0 before cut-over night (the import refuses to run otherwise).
--   "AUTO-FIXED"  problems are repaired by 05_import_v2.sql and written to the cutover report; no action needed.
--   "INFO"        row counts to compare with the import report.
-- Branch codes and the 15-minute cleaning gap below are Thalasso's (vv, def, gk, mg / bufferMins 15).
-- =====================================================================
with
bk as (select * from public.bookings where kind = 'booking'),
today as (select (now() at time zone 'Asia/Kolkata')::date as d),
room_clash as (
  select a.date, a.ref as a_ref, b.ref as b_ref
    from bk a join bk b on a.id < b.id and a.loc_id = b.loc_id and a.date = b.date and a.room_no = b.room_no
   where a.status = 'confirmed' and b.status = 'confirmed' and a.room_no is not null
     and a.start_min < b.end_min + 15 and b.start_min < a.end_min + 15
),
th_clash as (
  select a.ref as a_ref, b.ref as b_ref
    from bk a join bk b on a.id < b.id and a.therapist_id = b.therapist_id and a.date = b.date
   where a.status = 'confirmed' and b.status = 'confirmed' and a.therapist_id is not null
     and a.start_min < b.end_min and b.start_min < a.end_min
)
select * from (
  select 10 as ord, 'INFO       bookings to copy (confirmed, cancelled, no-show)' as check_name, count(*)::int as problems, '' as sample from bk
  union all select 11, 'INFO       temporary holds (not copied)', count(*)::int, '' from public.bookings where kind <> 'booking'
  union all select 12, 'INFO       therapists', count(*)::int, '' from public.therapists
  union all select 13, 'INFO       roster days', count(*)::int, '' from public.therapist_days
  union all select 20, 'MUST FIX   unknown branch code (not vv / def / gk / mg)',
    (select count(*) from public.bookings where loc_id not in ('vv','def','gk','mg'))::int
  + (select count(*) from public.therapists where loc_id not in ('vv','def','gk','mg'))::int
  + (select count(*) from public.therapist_days where loc_id not in ('vv','def','gk','mg'))::int, ''
  union all select 21, 'MUST FIX   room clash incl. 15-min cleaning gap, today or later (staff: move one booking)',
    count(*)::int, left(coalesce(string_agg(a_ref || ' / ' || b_ref, ', '), ''), 300) from room_clash, today where room_clash.date >= today.d
  union all select 22, 'AUTO-FIXED room clash in the past (the later booking loses its room number)',
    count(*)::int, left(coalesce(string_agg(a_ref || ' / ' || b_ref, ', '), ''), 300) from room_clash, today where room_clash.date < today.d
  union all select 22 + 0.5, 'MUST FIX   more guests than rooms at one moment, cleaning gap included, today or later (staff: move one booking)',
    count(distinct date::text || loc_id)::int, left(coalesce(string_agg(distinct date::text || ' ' || loc_id, ', '), ''), 300)
    from (select b.date, b.loc_id, b.ref from bk b, today
           where b.status = 'confirmed' and b.date >= today.d
             and (select count(*) from bk y where y.status = 'confirmed' and y.loc_id = b.loc_id and y.date = b.date
                    and y.start_min <= b.start_min and y.end_min + 15 > b.start_min)
                 > case b.loc_id when 'mg' then 10 else 6 end) over_cap
  union all select 23, 'MUST FIX   same therapist on two confirmed bookings at once', count(*)::int,
    left(coalesce(string_agg(a_ref || ' / ' || b_ref, ', '), ''), 300) from th_clash
  union all select 24, 'AUTO-FIXED duplicate booking references (the later ones get -2, -3 ...)',
    coalesce(sum(c - 1), 0)::int, left(coalesce(string_agg(ref, ', '), ''), 300)
    from (select ref, count(*) c from bk where ref is not null group by ref having count(*) > 1) d
  union all select 25, 'MUST FIX   two therapists at one branch whose names differ only by capitals',
    count(*)::int, left(coalesce(string_agg(n, ', '), ''), 300)
    from (select min(name) n from public.therapists group by loc_id, lower(name) having count(*) > 1) d
  union all select 26, 'MUST FIX   roster row whose shift end is not after arrival', count(*)::int, ''
    from public.therapist_days where shift_end_min is not null and shift_end_min <= arrival_min
  union all select 27, 'MUST FIX   booking numbers out of range (times, duration, price, add-on)', count(*)::int,
    left(coalesce(string_agg(ref, ', '), ''), 300) from bk
   where start_min not between 0 and 1439 or end_min <= start_min or end_min > 1440 or duration <= 0
      or price < 0 or price > 1000000 or addon_amt < 0 or addon_amt > 100000 or room_no < 1
      or orig_duration <= 0 or orig_price < 0
  union all select 28, 'MUST FIX   unknown status or source', count(*)::int, ''
    from bk where status not in ('confirmed', 'cancelled', 'noshow') or source not in ('online', 'phone', 'walkin')
  union all select 29, 'MUST FIX   roster row for a missing therapist or one from another branch', count(*)::int, ''
    from public.therapist_days d left join public.therapists t on t.id = d.therapist_id
   where t.id is null or t.loc_id <> d.loc_id
  union all select 30, 'MUST FIX   booking assigned to a therapist that no longer exists', count(*)::int, ''
    from bk left join public.therapists t on t.id = bk.therapist_id where bk.therapist_id is not null and t.id is null
  union all select 31, 'MUST FIX   therapist rostered twice on the same date', count(*)::int, ''
    from (select 1 from public.therapist_days group by therapist_id, date having count(*) > 1) d
  union all select 32, 'AUTO-FIXED add-on amount without a description (description "Add-on" is added)', count(*)::int, ''
    from bk where addon_amt > 0 and (addon_text is null or trim(addon_text) = '')
  union all select 33, 'AUTO-FIXED add-on description longer than 80 characters (cut to 80)', count(*)::int, ''
    from bk where length(addon_text) > 80
) r
order by ord;
