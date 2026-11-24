-- =====================================================================
-- THALASSO CUT-OVER  step 4b  ·  STAFF LOGINS (NEW project)  — do this days BEFORE cut-over night
-- Logins cannot be copied between Supabase projects: create each person under Authentication > Users > "Add user"
-- (email + a NEW password; tell staff in person), copy the user's UUID, then run one block per person.
-- Authentication > Sign In / Providers > "Allow new users to sign up" must stay OFF.
-- Roles: owner / manager = Menu & Prices tab (add treatments, edit prices), custom duration / price changes;
--        frontdesk       = bookings, rooms, therapists, standard menu duration changes.
-- Empty branch_ids = every branch. Replace the UUIDs and codes (vv = Vasant Vihar, def = Defence Colony,
-- gk = Greater Kailash, mg = MG Road Sultanpur) before running.
-- =====================================================================

-- owner: all branches
insert into public.staff (user_id, tenant_id, role)
select '<OWNER-USER-UUID>', id, 'owner' from public.tenants where slug = 'thalasso';

-- manager: all branches
insert into public.staff (user_id, tenant_id, role)
select '<MANAGER-USER-UUID>', id, 'manager' from public.tenants where slug = 'thalasso';

-- front desk limited to one branch (change 'vv' to the branch code)
insert into public.staff (user_id, tenant_id, role, branch_ids)
select '<DESK-USER-UUID>', t.id, 'frontdesk', array[b.id]
  from public.tenants t join public.branches b on b.tenant_id = t.id
 where t.slug = 'thalasso' and b.code = 'vv';

-- check
select u.email, s.role, coalesce((select string_agg(b.code, ', ') from public.branches b where b.id = any (s.branch_ids)), 'all branches') as branches
  from public.staff s join auth.users u on u.id = s.user_id
  join public.tenants t on t.id = s.tenant_id where t.slug = 'thalasso';
