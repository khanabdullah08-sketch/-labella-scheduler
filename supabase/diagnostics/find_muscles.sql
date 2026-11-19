-- READ-ONLY diagnostic: changes nothing. Paste the WHOLE file into a new Supabase SQL Editor tab and Run.
-- Purpose: find what in this project refers to a table called "muscles" (error 42P01) and
-- show which of our tables/triggers already exist. Send the result grid (or a screenshot) back.
--
-- kind          meaning
-- public table  a table that already exists in the public schema (we expect NONE before migration 0001)
-- trigger       a user trigger on a public table, and the function it calls
-- function      a function whose body mentions "muscles"
-- view / rule / policy / column default   other objects that mention "muscles"

select 'public table' as kind, table_name::text as detail
  from information_schema.tables
 where table_schema = 'public'

union all
select 'trigger',
       c.relname || '  ->  ' || t.tgname || '  calls  ' || t.tgfoid::regproc::text
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
 where not t.tgisinternal and c.relnamespace = 'public'::regnamespace

union all
select 'function', n.nspname || '.' || p.proname
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where p.prosrc ilike '%muscles%'

union all
select 'view', schemaname || '.' || viewname
  from pg_views
 where definition ilike '%muscles%'

union all
select 'rule', schemaname || '.' || tablename || '.' || rulename
  from pg_rules
 where definition ilike '%muscles%'

union all
select 'policy', schemaname || '.' || tablename || '.' || policyname
  from pg_policies
 where coalesce(qual, '') || coalesce(with_check, '') ilike '%muscles%'

union all
select 'column default', c.relname || '.' || a.attname
  from pg_attrdef d
  join pg_class c on c.oid = d.adrelid
  join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
 where c.relnamespace = 'public'::regnamespace
   and pg_get_expr(d.adbin, d.adrelid) ilike '%muscles%'

union all
select 'event trigger', evtname::text from pg_event_trigger

order by 1, 2;
