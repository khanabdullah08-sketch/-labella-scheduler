-- =====================================================================
-- 0001  Tenancy + catalog
-- Shared multi-tenant project. Every business ("tenant") owns its branches,
-- menus, services and staff. Run migrations in filename order.
-- Thalasso (Client 1) stays on its own legacy project and is NOT touched.
-- =====================================================================

create extension if not exists btree_gist with schema extensions;

-- Helper functions live in "private": never exposed through the Data API.
create schema if not exists private;
revoke all on schema private from public;

-- ---------------------------------------------------------------------
-- tenants: one row per client business
-- ---------------------------------------------------------------------
create table public.tenants (
  id                  uuid primary key default gen_random_uuid(),
  slug                text not null unique check (slug ~ '^[a-z0-9_-]{2,40}$'),
  name                text not null check (length(name) between 2 and 120),
  ref_prefix          text not null check (ref_prefix ~ '^[A-Z0-9-]{2,6}$'),
  timezone            text not null default 'Asia/Kolkata',
  phone_pattern       text not null default '^[6-9][0-9]{9}$',
  hold_minutes        int  not null default 7   check (hold_minutes between 1 and 30),
  buffer_mins         int  not null default 15  check (buffer_mins between 0 and 120),
  lead_mins           int  not null default 30  check (lead_mins between 0 and 1440),
  slot_step           int  not null default 30  check (slot_step between 5 and 120),
  booking_window_days int  not null default 30  check (booking_window_days between 1 and 365),
  therapist_daily_cap int  not null default 20  check (therapist_daily_cap between 1 and 200),
  active              boolean not null default true,
  created_at          timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- menus: a named list of services. A branch points at exactly one menu,
-- several branches may share a menu (Client 1) or each have their own (LaBella).
-- (id, tenant_id) is unique so child tables can use composite foreign keys
-- that make cross-tenant references impossible.
-- ---------------------------------------------------------------------
create table public.menus (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  code       text not null check (code ~ '^[a-z0-9_]{1,30}$'),
  name       text not null,
  unique (tenant_id, code),
  unique (id, tenant_id)
);

create table public.branches (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  code       text not null check (code ~ '^[a-z0-9_]{1,20}$'),   -- e.g. 'def', 'cp'
  name       text not null,
  short_name text not null,
  city       text not null,
  address    text not null,
  phone      text not null check (phone ~ '^[0-9]{10,15}$'),     -- WhatsApp number incl. country code
  rooms      int  not null check (rooms between 1 and 30),
  open_min   int  not null check (open_min  between 0 and 1440),  -- minutes since midnight
  close_min  int  not null check (close_min between 0 and 1440),
  menu_id    uuid not null,
  sort       int  not null default 0,
  active     boolean not null default true,
  unique (tenant_id, code),
  unique (id, tenant_id),
  check (open_min < close_min),
  foreign key (menu_id, tenant_id) references public.menus(id, tenant_id)
);

create table public.services (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  menu_id     uuid not null,
  code        text not null check (code ~ '^[a-z0-9_]{1,20}$'),
  category    text not null,
  name        text not null,
  description text not null default '',
  sort        int  not null default 0,
  active      boolean not null default true,
  unique (menu_id, code),
  unique (id, tenant_id),
  foreign key (menu_id, tenant_id) references public.menus(id, tenant_id) on delete cascade
);

create table public.service_options (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  service_id   uuid not null,
  duration_min int  not null check (duration_min between 5 and 480),
  price        int  not null check (price between 0 and 1000000),   -- whole rupees
  sort         int  not null default 0,
  active       boolean not null default true,
  unique (service_id, duration_min),
  foreign key (service_id, tenant_id) references public.services(id, tenant_id) on delete cascade
);

-- ---------------------------------------------------------------------
-- staff: who may log in to the Day View console, for which tenant/branches.
-- A user belongs to exactly one tenant. Empty branch_ids = all branches.
-- Rows are created by the owner of the platform (SQL editor / service role),
-- never by the browser.
-- ---------------------------------------------------------------------
create table public.staff (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  role       text not null check (role in ('owner','manager','frontdesk')),
  branch_ids uuid[] not null default '{}',
  created_at timestamptz not null default now()
);
create index staff_tenant_idx on public.staff (tenant_id);

create index branches_tenant_idx on public.branches (tenant_id);
create index services_menu_idx   on public.services (menu_id);
