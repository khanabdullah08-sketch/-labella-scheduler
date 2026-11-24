-- =====================================================================
-- THALASSO CUT-OVER  step 2 of 7  ·  FREEZE THE OLD DATABASE (cut-over night, just before the export)
-- Run in the OLD Thalasso Supabase project. Afterwards nothing can add, change or delete a booking, therapist
-- or roster row there: guests see "Could not hold that slot", staff see an error. Reads still work, so the old
-- site stays visible. To undo (rollback, or if cut-over is called off) run 02b_unfreeze_legacy.sql.
-- =====================================================================
create or replace function public.cutover_frozen()
returns trigger
language plpgsql
as $$
begin
  raise exception 'FROZEN: Thalasso is being moved to the new system. Try again in a few minutes.';
end $$;

drop trigger if exists cutover_freeze on public.bookings;
drop trigger if exists cutover_freeze on public.therapists;
drop trigger if exists cutover_freeze on public.therapist_days;

create trigger cutover_freeze before insert or update or delete on public.bookings
  for each statement execute function public.cutover_frozen();
create trigger cutover_freeze before insert or update or delete on public.therapists
  for each statement execute function public.cutover_frozen();
create trigger cutover_freeze before insert or update or delete on public.therapist_days
  for each statement execute function public.cutover_frozen();
