-- =====================================================================
-- 0002  Permission helpers + therapist roster
-- Column names deliberately match the legacy Thalasso schema (loc_id, start_min, ...)
-- so the staff console code is shared by both backends.
-- =====================================================================

-- p_branch NULL = tenant-wide check. Empty branch_ids = all branches of the tenant.
create or replace function private.staff_ok(p_tenant uuid, p_branch uuid default null)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.staff s
     where s.user_id = auth.uid()
       and s.tenant_id = p_tenant
       and (p_branch is null
            or cardinality(s.branch_ids) = 0
            or p_branch = any (s.branch_ids))
  );
$$;

create or replace function private.my_tenant()
returns uuid
language sql stable security definer
set search_path = public, pg_temp
as $$ select s.tenant_id from public.staff s where s.user_id = auth.uid(); $$;

create or replace function private.is_manager(p_tenant uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.staff s
                  where s.user_id = auth.uid() and s.tenant_id = p_tenant
                    and s.role in ('owner','manager'));
$$;

-- ---------------------------------------------------------------------
create table public.therapists (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null,
  branch_id  uuid not null,
  loc_id     text not null,                     -- branch code (the console sends this)
  name       text not null check (length(trim(name)) >= 2),
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  unique (id, tenant_id),
  foreign key (branch_id, tenant_id) references public.branches(id, tenant_id) on delete cascade
);
create unique index therapists_branch_name_uq on public.therapists (branch_id, lower(name));

create table public.therapist_days (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null,
  branch_id     uuid not null,
  loc_id        text not null,
  therapist_id  uuid not null references public.therapists(id) on delete cascade,
  date          date not null,
  arrival_min   int  not null check (arrival_min between 0 and 1440),
  shift_end_min int  check (shift_end_min between 0 and 1440),
  on_leave      boolean not null default false,
  seq           int  not null default 0,
  created_at    timestamptz not null default now(),
  unique (therapist_id, date),
  foreign key (branch_id, tenant_id) references public.branches(id, tenant_id) on delete cascade
);
create index therapist_days_lookup_idx on public.therapist_days (branch_id, date);
