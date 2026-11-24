-- =====================================================================
-- Undo 02_freeze_legacy.sql (OLD Thalasso project): bookings, therapists and roster accept changes again.
-- Use it when cut-over is called off, or at the start of a rollback (after 07_rollback_export_v2.sql was applied).
-- =====================================================================
drop trigger if exists cutover_freeze on public.bookings;
drop trigger if exists cutover_freeze on public.therapists;
drop trigger if exists cutover_freeze on public.therapist_days;
drop function if exists public.cutover_frozen();
