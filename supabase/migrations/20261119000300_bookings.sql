-- =====================================================================
-- 0003  Bookings (confirmed bookings AND short-lived holds) + the
--       database-level double-booking guards.
-- =====================================================================
create table public.bookings (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  tenant_id      uuid not null,
  branch_id      uuid not null,
  loc_id         text not null,
  loc_name       text,
  kind           text not null default 'booking' check (kind in ('booking','hold')),
  status         text not null default 'confirmed' check (status in ('confirmed','cancelled','noshow')),
  ref            text,
  service_id     text,                           -- services.code at booking time
  service_name   text,                           -- snapshot, e.g. 'Thai Massage (60 Mins)'
  duration       int  not null check (duration > 0),
  price          int  not null default 0 check (price >= 0),   -- snapshot copied from service_options
  date           date not null,
  start_min      int  not null check (start_min between 0 and 1439),
  end_min        int  not null,
  block_end_min  int  not null,                  -- end_min + tenant cleaning buffer (set by trigger)
  room_no        int  not null default 1 check (room_no >= 1),
  name           text,
  phone          text,
  notes          text default 'None',
  source         text not null default 'online' check (source in ('online','phone','walkin')),
  created_by     text,
  token          text,
  expires_at     timestamptz,
  therapist_id   uuid references public.therapists(id) on delete set null,
  therapist_name text,
  check (end_min > start_min and end_min <= 1440),
  check (kind <> 'hold' or (token is not null and expires_at is not null)),
  foreign key (branch_id, tenant_id) references public.branches(id, tenant_id)
);

create unique index bookings_ref_uq   on public.bookings (tenant_id, ref) where ref is not null;
create index bookings_day_idx         on public.bookings (tenant_id, loc_id, date);
create index bookings_token_idx       on public.bookings (token) where token is not null;
create index bookings_hold_expiry_idx on public.bookings (expires_at) where kind = 'hold';

-- (a) A room cannot host two live bookings whose [start, end + cleaning buffer) overlap.
--     This also applies to staff phone/walk-in bookings (the old system skipped the buffer there).
alter table public.bookings add constraint bookings_room_no_overlap
  exclude using gist (
    branch_id with =, date with =, room_no with =,
    int4range(start_min, block_end_min) with &&
  ) where (status = 'confirmed');

-- (b) A therapist cannot be on two live bookings at the same time.
alter table public.bookings add constraint bookings_therapist_no_overlap
  exclude using gist (
    therapist_id with =, date with =,
    int4range(start_min, end_min) with &&
  ) where (therapist_id is not null and status = 'confirmed' and kind = 'booking');
