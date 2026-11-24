import { istDay } from './harness.mjs';
import { ins, uuid } from './cutover-fixture.mjs';

/**
 * A realistic little Thalasso: 2 therapists, 2 roster days, 10 bookings with every kind of oddity, plus 1 temporary hold.
 *   TL-100006 sits 5 minutes after TL-100005 in the same room (the old system had no cleaning gap)
 *   TL-100007 is used twice (two branches)   TL-100008 has an add-on amount without a description
 */
export async function fillLegacy(db) {
  const past = await istDay(db, -3), fut = await istDay(db, 2);
  const asha = uuid(), meena = uuid();
  await ins(db, 'therapists', { id: asha, loc_id: 'vv', name: 'Asha Nair', created_at: '2026-10-01T05:00:00Z' });
  await ins(db, 'therapists', { id: meena, loc_id: 'def', name: 'Meena Rao', created_at: '2026-10-02T05:00:00Z' });
  await ins(db, 'therapist_days', { therapist_id: asha, loc_id: 'vv', date: fut, arrival_min: 690, seq: 1 });
  await ins(db, 'therapist_days', { therapist_id: meena, loc_id: 'def', date: past, arrival_min: 700, seq: 1 });
  const base = { kind: 'booking', status: 'confirmed', phone: '9876543210', source: 'online', duration: 60, price: 2500 };
  const vv = { loc_id: 'vv', loc_name: 'Vasant Vihar Sanctuary' }, def = { loc_id: 'def', loc_name: 'Defence Colony Sanctuary' };
  const gk = { loc_id: 'gk', loc_name: 'Greater Kailash Sanctuary' }, mg = { loc_id: 'mg', loc_name: 'MG Road Sultanpur' };
  const rows = [
    { ...base, ...vv, ref: 'TL-100001', date: fut, start_min: 720, end_min: 780, room_no: 1, name: 'Priya', therapist_id: asha, therapist_name: 'Asha Nair', addon_text: 'Head massage', addon_amt: 300, source: 'phone' },
    { ...base, ...vv, ref: 'TL-100002', date: fut, start_min: 750, end_min: 810, room_no: 2, name: 'Rahul' },
    { ...base, ...def, ref: 'TL-100003', date: fut, start_min: 840, end_min: 930, room_no: null, name: 'Sunita', source: 'walkin', duration: 90, price: 3500,
      orig_duration: 60, orig_price: 2500, adjusted_by: 'owner@th.test', adjusted_at: '2026-11-20T08:00:00Z' },
    { ...base, ...gk, ref: 'TL-100004', date: past, start_min: 720, end_min: 780, room_no: 1, name: 'Anil', status: 'cancelled' },
    { ...base, ...mg, ref: 'TL-100005', date: past, start_min: 720, end_min: 780, room_no: 3, name: 'Kavita' },
    { ...base, ...mg, ref: 'TL-100006', date: past, start_min: 785, end_min: 845, room_no: 3, name: 'Deepak' },
    { ...base, ...vv, ref: 'TL-100007', date: past, start_min: 600, end_min: 660, room_no: 4, name: 'Neha' },
    { ...base, ...def, ref: 'TL-100007', date: past, start_min: 600, end_min: 660, room_no: 4, name: 'Karan' },
    { ...base, ...gk, ref: 'TL-100008', date: past, start_min: 900, end_min: 960, room_no: 2, name: 'Isha', addon_text: null, addon_amt: 150, source: 'phone' },
    { ...base, ...def, ref: 'TL-100009', date: past, start_min: 780, end_min: 840, room_no: 5, name: 'Vikram', status: 'noshow', therapist_id: meena, therapist_name: 'Meena Rao' }
  ];
  for (const b of rows) await ins(db, 'bookings', { id: uuid(), ...b });
  await ins(db, 'bookings', { kind: 'hold', status: 'confirmed', loc_id: 'vv', date: fut, start_min: 900, end_min: 960, duration: 60, room_no: 5,
    token: 'h-123456789', expires_at: new Date(Date.now() + 600000).toISOString() });
  return { past, fut, asha, meena };
}
