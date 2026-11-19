import test from 'node:test';
import assert from 'node:assert/strict';
import { anon, asUser, istDay } from './harness.mjs';
import { makeFixture, makeBooker } from './fixture.mjs';

const { db, ids } = await makeFixture();
const day = await istDay(db, 2);
const book = makeBooker(db, day);
const hold = (branch, service, dur, start, tok, d = day, seen = null) => anon(db, async () => (await db.query(
  `select create_hold_v2('labella', $1, $2::date, $3, $4, $5, $6, $7) r`, [branch, d, start, service, dur, tok, seen])).rows[0].r);
const count = async sql => (await db.query(sql)).rows[0].n;

test('a confirmed online booking gets a LB- reference and the menu price (not a browser price)', async () => {
  const r = await book('def', 'df01', 60, 720);          // Moroccan Bath 60 min
  assert.equal(r.status, 'ok');
  assert.match(r.ref, /^LB-\d{6}$/);
  const b = (await db.query(`select price, service_name, loc_name, duration, end_min, kind from bookings where ref = $1`, [r.ref])).rows[0];
  assert.deepEqual(b, { price: 5000, service_name: 'Moroccan Bath (60 Mins)', loc_name: 'Defence Colony', duration: 60, end_min: 780, kind: 'booking' });
});

test('services and durations are checked against THAT branch\'s own menu', async () => {
  assert.equal(await hold('def', 'cp03', 60, 840, 'tok-aaaaaaaa1'), 'invalid');     // a CP service id at Defence Colony
  assert.equal(await hold('cp', 'df01', 60, 840, 'tok-aaaaaaaa2'), 'invalid');      // a DEF service id at Connaught Place
  assert.equal(await hold('def', 'df01', 75, 840, 'tok-aaaaaaaa3'), 'invalid');     // duration not offered for that service
  assert.equal(await hold('cp', 'cp14', 75, 840, 'tok-aaaaaaaa4'), 'ok');           // 75-minute couples package exists at CP
  assert.equal(await hold('def', 'df18', 105, 900, 'tok-aaaaaaaa5'), 'ok');         // 105-minute Grand exists at DEF
});

test('the same treatment costs what each branch\'s menu says', async () => {
  const a = await book('def', 'df06', 60, 600 + 120);      // Balinese at DEF: 2,799
  const b = await book('cp', 'cp03', 60, 600 + 120);       // Balinese at CP: 3,799
  const p = async ref => (await db.query(`select price from bookings where ref = $1`, [ref])).rows[0].price;
  assert.equal(await p(a.ref), 2799);
  assert.equal(await p(b.ref), 3799);
});

test('a price the page saw that no longer matches is refused', async () => {
  assert.equal(await hold('def', 'df01', 60, 1020, 'tok-price-001', day, 4999), 'price_changed');
  assert.equal(await hold('def', 'df01', 60, 1020, 'tok-price-002', day, 5000), 'ok');
});

test('start times must be on the branch slot grid (11:00, 11:30, ...)', async () => {
  assert.equal(await hold('def', 'df01', 60, 1000, 'tok-grid-0001'), 'invalid');
  assert.equal(await hold('def', 'df01', 60, 1050, 'tok-grid-0002'), 'ok');
});

test('each branch enforces its own opening hours', async () => {
  // Defence Colony 11:00 (660) - 23:00 (1380); Connaught Place 11:00 - 22:00 (1320)
  assert.equal(await hold('def', 'df01', 60, 1320, 'tok-hours-001'), 'ok');       // 22:00-23:00 fits at DEF
  assert.equal(await hold('cp', 'cp03', 60, 1320, 'tok-hours-002'), 'closed');    // 22:00-23:00 does NOT fit at CP
  assert.equal(await hold('cp', 'cp03', 60, 1260, 'tok-hours-003'), 'ok');        // 21:00-22:00 fits at CP
  assert.equal(await hold('cp', 'cp04', 90, 1260, 'tok-hours-004'), 'closed');    // 21:00 + 90 min runs past 22:00
  assert.equal(await hold('def', 'df01', 60, 630, 'tok-hours-005'), 'closed');    // 10:30 is before 11:00 opening
});

test('dates: past, too far ahead, and too soon today are refused', async () => {
  assert.equal(await hold('def', 'df01', 60, 840, 'tok-date-0001', await istDay(db, -1)), 'baddate');
  assert.equal(await hold('def', 'df01', 60, 840, 'tok-date-0002', await istDay(db, 40)), 'baddate');
  const nowMin = (await db.query(`select extract(hour from now() at time zone 'Asia/Kolkata')::int * 60 + extract(minute from now() at time zone 'Asia/Kolkata')::int n`)).rows[0].n;
  const soon = Math.floor(nowMin / 30) * 30;               // the slot that has already started: always inside the lead time
  if (soon + 60 <= 1380 && soon >= 660) assert.equal(await hold('def', 'df01', 60, soon, 'tok-date-0003', await istDay(db, 0)), 'toosoon');
});

test('Connaught Place has exactly 6 rooms: the 7th simultaneous booking is "full"', async () => {
  const d = await istDay(db, 4), start = 900;             // a day nothing else touches, 3:00 PM
  for (let i = 1; i <= 6; i++) assert.equal(await hold('cp', 'cp03', 60, start, 'tok-full-' + i + '-xxxx', d), 'ok', 'room ' + i);
  assert.equal(await hold('cp', 'cp03', 60, start, 'tok-full-7-xxxx', d), 'full');
  assert.equal(await count(`select count(distinct room_no)::int n from bookings b join branches r on r.id = b.branch_id where r.code='cp' and b.start_min = 900 and b.date = '${d}'`), 6);
});

test('Defence Colony has 14 rooms; the 15th is refused; branches do not share rooms', async () => {
  const d = await istDay(db, 5), start = 960;             // a day nothing else touches, 4:00 PM
  for (let i = 1; i <= 14; i++) assert.equal(await hold('def', 'df06', 60, start, 'tok-def-' + i + '-xxxxx', d), 'ok', 'room ' + i);
  assert.equal(await hold('def', 'df06', 60, start, 'tok-def-15-xxxxx', d), 'full');
  assert.equal(await hold('cp', 'cp03', 60, start, 'tok-cp-at-4pm-xx', d), 'ok');        // CP unaffected by DEF being full
});

test('the 15-minute cleaning gap is enforced for online AND staff bookings', async () => {
  const d3 = await istDay(db, 3), b3 = makeBooker(db, d3);
  // fill all 6 CP rooms 11:00-12:00
  for (let i = 0; i < 6; i++) assert.equal((await b3('cp', 'cp03', 60, 660)).status, 'ok');
  // 12:00 start is inside the 15-min cleaning window of those bookings -> full
  assert.equal(await hold('cp', 'cp03', 60, 720, 'tok-gap-online-1', d3), 'full');
  // staff booking at 12:00 must ALSO be refused (the old system skipped the gap for staff)
  const s = await asUser(db, ids.owner, async () => (await db.query(
    `select staff_create_booking('cp','cp03',60,$1::date,720,'Walk In','9876543210','','walkin') r`, [d3])).rows[0].r);
  assert.equal(s.status, 'full');
  // 12:30 is outside the cleaning window -> allowed
  assert.equal(await hold('cp', 'cp03', 60, 750, 'tok-gap-online-2', d3), 'ok');
});
