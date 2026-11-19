-- READ-ONLY probes. Run each numbered query ALONE in its own new SQL Editor tab and note the result.
-- (Supabase shows only the last statement's result, so do not paste them together.)

-- PROBE 1 -- Does the editor accept the words from the failing treatment descriptions as plain text?
-- Expected: one row containing  massaged deep into muscles.
select 'massaged deep into muscles.' as probe_text;

-- PROBE 2 -- How much of the seed is in the database right now?
-- Expected after a failed seed run: all zeros (the seed is one transaction, so a failure leaves nothing behind).
select (select count(*) from public.tenants)         as tenants,
       (select count(*) from public.menus)           as menus,
       (select count(*) from public.branches)        as branches,
       (select count(*) from public.services)        as services,
       (select count(*) from public.service_options) as options;

-- PROBE 3 -- Is anything already attached to the tables the seed writes to (rules, extra triggers, inheritance)?
-- Expected: only the 3 triggers on bookings / therapists / therapist_days, and no rules.
select 'rule' as kind, tablename || '.' || rulename as detail
  from pg_rules where schemaname = 'public'
union all
select 'trigger', c.relname || '.' || t.tgname
  from pg_trigger t join pg_class c on c.oid = t.tgrelid
 where not t.tgisinternal and c.relnamespace = 'public'::regnamespace
union all
select 'inherits', c.relname || ' <- ' || p.relname
  from pg_inherits i join pg_class c on c.oid = i.inhrelid join pg_class p on p.oid = i.inhparent
 where c.relnamespace = 'public'::regnamespace;
