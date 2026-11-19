/* ============================================================
   1. TENANT CONFIG
   Injected at build time as window.APP_CONFIG (see scripts/build.mjs).
   Nothing client-specific may be hardcoded in this file — it lives in
   tenants/<slug>/tenant.json and tenants/<slug>/catalog.json.
   ============================================================ */
const CFG = window.APP_CONFIG;
const RULES = CFG.rules;

const SUPA_URL = CFG.supabase.url;
const SUPA_KEY = CFG.supabase.anonKey;
const sb = supabase.createClient(SUPA_URL, SUPA_KEY);

const SLOT_STEP     = RULES.slotStep;
const BUFFER_MINS   = RULES.bufferMins;      // cleaning gap between sessions
const LEAD_MINS     = RULES.leadMins;        // minimum notice for same-day bookings
const HOLD_MINS     = RULES.holdMinutes;     // must match the hold length enforced in the database
const BOOKING_DAYS  = RULES.bookingDays;     // how many days ahead guests can book
const TH_MAX        = RULES.therapistMax;    // therapists per branch per day

/* ============================================================
   2. BRANCHES  (id, name, shortName, city, phone, address, rooms, menu,
                 optional openMin / closeMin overriding the tenant default)
   ============================================================ */
const LOCATIONS = CFG.branches;
const ROOMS = Object.fromEntries(LOCATIONS.map(l => [l.id, l.rooms]));
const branchOf = id => LOCATIONS.find(l => l.id === id);
const openOf   = id => { const b = branchOf(id); return b && b.openMin  != null ? b.openMin  : RULES.openMin; };
const closeOf  = id => { const b = branchOf(id); return b && b.closeMin != null ? b.closeMin : RULES.closeMin; };

/* ============================================================
   3. SERVICES MENUS  (each branch points at a named menu)
   ============================================================ */
const MENU_LIST    = CFG.menus;
const DEFAULT_MENU = MENU_LIST[CFG.defaultMenu];
const MENUS   = Object.fromEntries(LOCATIONS.map(l => [l.id, MENU_LIST[l.menu]]));
const menuFor = id => MENUS[id] || DEFAULT_MENU;

/* Active menu — swapped when the guest picks a branch. Must be `let`, not `const`. */
let SERVICES = DEFAULT_MENU;



/* ============================================================
   4. STATE + HELPERS
   ============================================================ */
let bookingState = { step: 1, location: null, service: null, selectedOption: null,
                     date: null, timeSlot: null, startMinutes: null, customer: {} };

let holdToken = null, holdDeadline = null, holdTicker = null;

const pad2 = n => String(n).padStart(2, '0');
const ymdLocal = d => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
function minsToText(m) {
    const h = Math.floor(m / 60), mm = m % 60;
    return (h % 12 || 12) + ':' + pad2(mm) + ' ' + (h >= 12 ? 'PM' : 'AM');
}
const money = n => CFG.locale.currencySymbol + (Number(n) || 0).toLocaleString(CFG.locale.numberLocale);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const capOf = id => ROOMS[id] || 4;
const nowMins = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
const PHONE_CORE = CFG.locale.phonePattern;   // e.g. [6-9]\d{9}
const PHONE_RE = new RegExp('^' + PHONE_CORE + '$');
const PHONE_PREFIX_RE = new RegExp('^(00' + CFG.locale.countryCode + '|' + CFG.locale.countryCode + '|0)(?=' + PHONE_CORE + '$)');
const cleanPhone = v => String(v || '').replace(/\D/g, '').replace(PHONE_PREFIX_RE, '');

/* ---- hold countdown (length comes from tenant config) ---- */
function startHoldCountdown() {
    holdDeadline = Date.now() + HOLD_MINS * 60 * 1000;
    clearInterval(holdTicker);
    const bar = document.getElementById('holdBar');
    bar.classList.remove('hidden');
    const tick = () => {
        const left = Math.max(0, Math.round((holdDeadline - Date.now()) / 1000));
        bar.innerText = 'Slot held for you — ' + Math.floor(left / 60) + ':' + pad2(left % 60) + ' remaining';
        if (left <= 0) {
            clearInterval(holdTicker);
            bar.classList.add('hidden');
            holdToken = null;
            alert('Your ' + HOLD_MINS + '-minute hold has expired. Please choose a time again.');
            goToStep(3); renderTimeSlots();
        }
    };
    tick();
    holdTicker = setInterval(tick, 1000);
}
function stopHoldCountdown() {
    clearInterval(holdTicker);
    document.getElementById('holdBar').classList.add('hidden');
}
async function releaseHold() {
    if (!holdToken) return;
    const t = holdToken; holdToken = null; stopHoldCountdown();
    try { await sb.rpc('release_hold', { p_token: t }); } catch (e) {}
}
window.addEventListener('beforeunload', () => {
    if (holdToken) sb.rpc('release_hold', { p_token: holdToken });
});

/* ============================================================
   5. INITIALISATION
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
    renderLocations();
    renderCategories();
    renderServices('All');
    generateDates();
    dvInitPickers();
});

/* ============================================================
   6. STEP 1 — LOCATIONS
   ============================================================ */
function renderLocations() {
    document.getElementById('locationsGrid').innerHTML = LOCATIONS.map(loc => `
        <div onclick="selectLocation('${loc.id}')" class="p-4 bg-white border border-sand-200 rounded-xl hover:border-brand-500 hover:shadow-sm cursor-pointer transition flex justify-between items-center gap-3">
            <div>
                <h3 class="font-bold text-brand-900">${esc(loc.name)}</h3>
                <p class="text-xs text-sand-800">${esc(loc.address)}</p>
            </div>
            <span class="text-xs font-semibold text-brand-600 bg-brand-50 px-2.5 py-1 rounded-full whitespace-nowrap">${esc(loc.city)}</span>
        </div>`).join('');
}
/* Show the selected branch's own opening hours on the time step. */
function applyHours(id) {
    const hrs = document.getElementById('hoursText');
    const cap = document.getElementById('capText');
    if (hrs) hrs.innerText = 'Operating Hours: ' + minsToText(openOf(id)) + ' – ' + minsToText(closeOf(id)) + ' daily.';
    if (cap) cap.innerText = 'Capped at ' + minsToText(closeOf(id));
}
async function selectLocation(id) {
    await releaseHold();
    bookingState.location = LOCATIONS.find(l => l.id === id);
    SERVICES = menuFor(id);
    applyHours(id);
    bookingState.service = null;
    bookingState.selectedOption = null;
    bookingState.startMinutes = null;
    bookingState.timeSlot = null;
    renderCategories();
    renderServices('All');
    goToStep(2);
}

/* ============================================================
   7. STEP 2 — SERVICES
   ============================================================ */
function renderCategories() {
    const categories = ['All', ...new Set(SERVICES.map(s => s.cat))];
    document.getElementById('categoryTabs').innerHTML = categories.map((cat, idx) => `
        <button onclick="filterCategory('${cat}', this)" class="px-3.5 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap transition ${idx === 0 ? 'bg-brand-800 text-white' : 'bg-sand-100 text-brand-800 hover:bg-sand-200'}">${cat}</button>`).join('');
}
function filterCategory(cat, btnEl) {
    document.querySelectorAll('#categoryTabs button').forEach(b => {
        b.className = 'px-3.5 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap transition bg-sand-100 text-brand-800 hover:bg-sand-200';
    });
    btnEl.className = 'px-3.5 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap transition bg-brand-800 text-white';
    renderServices(cat);
}
function renderServices(cat) {
    const filtered = cat === 'All' ? SERVICES : SERVICES.filter(s => s.cat === cat);
    document.getElementById('servicesList').innerHTML = filtered.map(s => `
        <div class="p-4 bg-white border border-sand-200 rounded-xl space-y-3">
            <div>
                <div class="flex justify-between items-start gap-2">
                    <h3 class="font-bold text-brand-900 text-sm">${esc(s.name)}</h3>
                    <span class="text-[10px] uppercase font-bold text-brand-600 bg-brand-50 px-2 py-0.5 rounded whitespace-nowrap">${esc(s.cat)}</span>
                </div>
                <p class="text-xs text-sand-800 mt-1">${esc(s.desc)}</p>
            </div>
            <div class="flex flex-wrap gap-2 pt-1 border-t border-sand-100">
                ${s.options.map(opt => `
                    <button onclick="selectServiceOption('${s.id}', ${opt.duration}, ${opt.price})" class="flex-1 py-2 px-3 bg-sand-50 border border-sand-200 rounded-lg hover:border-brand-500 hover:bg-brand-50 transition text-left flex justify-between items-center gap-2">
                        <span class="text-xs font-medium text-brand-800">${opt.duration} Mins</span>
                        <span class="text-xs font-bold text-brand-900">${money(opt.price)}</span>
                    </button>`).join('')}
            </div>
        </div>`).join('');
}
async function selectServiceOption(serviceId, duration, price) {
    await releaseHold();
    bookingState.service = SERVICES.find(s => s.id === serviceId);
    bookingState.selectedOption = { duration, price };
    bookingState.startMinutes = null;
    bookingState.timeSlot = null;
    document.getElementById('selectedServiceDurationText').innerText = duration + ' mins';
    document.getElementById('timeNextBtn').disabled = true;
    goToStep(3);
    renderTimeSlots();
}

/* ============================================================
   8. STEP 3 — DATES & LIVE SLOTS
   ============================================================ */
function generateDates() {
    const container = document.getElementById('dateChips');
    const dates = [], today = new Date();
    for (let i = 0; i < BOOKING_DAYS; i++) { const d = new Date(today); d.setDate(today.getDate() + i); dates.push(d); }

    container.innerHTML = dates.map((d, idx) => `
        <button onclick="selectDate('${ymdLocal(d)}', this)" class="flex-shrink-0 px-4 py-2 rounded-xl border text-center transition ${idx === 0 ? 'bg-brand-800 text-white border-brand-800' : 'bg-white border-sand-200 text-brand-800 hover:border-brand-500'}">
            <div class="text-[10px] uppercase font-semibold opacity-80">${d.toLocaleDateString(CFG.locale.numberLocale, { weekday: 'short' })}</div>
            <div class="text-base font-extrabold">${d.getDate()} ${d.toLocaleDateString(CFG.locale.numberLocale, { month: 'short' })}</div>
        </button>`).join('');

    bookingState.date = ymdLocal(dates[0]);
}

async function selectDate(dateStr, btnEl) {
    await releaseHold();
    bookingState.date = dateStr;
    bookingState.timeSlot = null;
    bookingState.startMinutes = null;
    document.getElementById('timeNextBtn').disabled = true;
    if (btnEl) {
        document.querySelectorAll('#dateChips button').forEach(b => {
            b.className = 'flex-shrink-0 px-4 py-2 rounded-xl border text-center transition bg-white border-sand-200 text-brand-800 hover:border-brand-500';
        });
        btnEl.className = 'flex-shrink-0 px-4 py-2 rounded-xl border text-center transition bg-brand-800 text-white border-brand-800';
    }
    renderTimeSlots();
}

async function renderTimeSlots() {
    const container = document.getElementById('timeSlotsGrid');
    if (!bookingState.location || !bookingState.date) return;

    const duration = bookingState.selectedOption ? bookingState.selectedOption.duration : 60;
    const capacity = capOf(bookingState.location.id);
    const openAt = openOf(bookingState.location.id), closeAt = closeOf(bookingState.location.id);

    container.innerHTML = '<div class="col-span-full text-xs text-sand-800 py-4 text-center">Checking live availability…</div>';

    const { data, error } = await sb.rpc('get_busy', {
        p_loc: bookingState.location.id,
        p_date: bookingState.date,
        p_token: holdToken
    });

    if (error) {
        container.innerHTML = '<div class="col-span-full text-xs text-red-700 py-4 text-center">Could not load availability. Check your internet, then tap the date again.</div>';
        return;
    }

    const busy = (data || []).filter(b => !b.mine);
    const isToday = bookingState.date === ymdLocal(new Date());
    const n = nowMins();
    const slots = [];

    for (let current = openAt; current <= closeAt - SLOT_STEP; current += SLOT_STEP) {
        const end = current + duration;
        let disabled = false;
        if (end > closeAt) disabled = true;
        else if (isToday && current < n + LEAD_MINS) disabled = true;
        else {
            const clashes = busy.filter(b => (current - BUFFER_MINS) < b.e_min && (end + BUFFER_MINS) > b.s_min).length;
            if (clashes >= capacity) disabled = true;
        }
        slots.push({ text: minsToText(current), start: current, disabled });
    }

    container.innerHTML = slots.map(s => `
        <button ${s.disabled ? 'disabled' : ''} data-start="${s.start}" onclick="selectTimeSlot(${s.start}, this)"
            class="py-2.5 px-2 rounded-xl border text-center transition text-xs font-bold ${s.disabled
                ? 'bg-sand-100 border-sand-200 text-sand-800 opacity-40 cursor-not-allowed line-through'
                : 'bg-white border-sand-200 text-brand-900 hover:border-brand-500 hover:bg-brand-50'}">${s.text}</button>`).join('');

    if (bookingState.startMinutes) highlightSlot(bookingState.startMinutes);
}

function highlightSlot(start) {
    const btn = document.querySelector('#timeSlotsGrid button[data-start="' + start + '"]');
    if (!btn) return;
    btn.disabled = false;
    btn.className = 'py-2.5 px-2 rounded-xl border text-center transition text-xs font-bold bg-brand-800 text-white border-brand-800 shadow-sm';
}

async function selectTimeSlot(startMinutes, btnEl) {
    document.getElementById('timeNextBtn').disabled = true;
    const original = btnEl.innerText;
    btnEl.innerText = '…';
    await releaseHold();

    const token = 'h-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
    const { data, error } = await sb.rpc('create_hold', {
        p_loc: bookingState.location.id,
        p_date: bookingState.date,
        p_start: startMinutes,
        p_duration: bookingState.selectedOption.duration,
        p_rooms: capOf(bookingState.location.id),
        p_token: token
    });

    if (error || data !== 'ok') {
        btnEl.innerText = original;
        alert(data === 'full'
            ? 'Sorry — that slot was just taken by someone else. Please pick another time.'
            : 'Could not hold that slot. Please check your internet and try again.');
        renderTimeSlots();
        return;
    }

    holdToken = token;
    bookingState.startMinutes = startMinutes;
    bookingState.timeSlot = minsToText(startMinutes);
    startHoldCountdown();
    await renderTimeSlots();
    document.getElementById('timeNextBtn').disabled = false;
}

/* ============================================================
   9. NAVIGATION
   ============================================================ */
function goToStep(stepNum) {
    bookingState.step = stepNum;
    ['stepLocation','stepService','stepTime','stepConfirm','stepSuccess'].forEach(id => {
        document.getElementById(id).classList.add('hidden');
    });
    const backBtn = document.getElementById('backBtn');
    if (stepNum > 1 && stepNum < 5) backBtn.classList.remove('hidden'); else backBtn.classList.add('hidden');

    for (let i = 1; i <= 4; i++) {
        const el = document.getElementById('stepLabel' + i);
        if (!el) continue;
        if (i === stepNum) el.className = 'text-brand-800 font-bold';
        else if (i < stepNum) el.className = 'text-brand-600 font-semibold';
        else el.className = 'text-sand-800';
    }

    if (stepNum === 1) document.getElementById('stepLocation').classList.remove('hidden');
    if (stepNum === 2) document.getElementById('stepService').classList.remove('hidden');
    if (stepNum === 3) document.getElementById('stepTime').classList.remove('hidden');
    if (stepNum === 4) { populateSummary(); document.getElementById('stepConfirm').classList.remove('hidden'); }
    if (stepNum === 5) document.getElementById('stepSuccess').classList.remove('hidden');

    window.scrollTo({ top: 0, behavior: 'smooth' });
}
function handleBackNav() { if (bookingState.step > 1) goToStep(bookingState.step - 1); }
function populateSummary() {
    document.getElementById('summaryLocation').innerText = bookingState.location.name;
    document.getElementById('summaryService').innerText  = bookingState.service.name + ' (' + bookingState.selectedOption.duration + ' Mins)';
    document.getElementById('summaryDateTime').innerText = bookingState.date + ' @ ' + bookingState.timeSlot;
    document.getElementById('summaryPrice').innerText    = money(bookingState.selectedOption.price);
    document.getElementById('summaryLocation').title = bookingState.location.address;
}

/* ============================================================
   10. STEP 4 — CONFIRM IN CLOUD, THEN WHATSAPP
   ============================================================ */
async function handleFormSubmit(e) {
    e.preventDefault();
    const submitBtn = e.target.querySelector('button[type="submit"]');
    const label = submitBtn.querySelector('span');

    const name  = document.getElementById('custName').value.trim();
    const phone = cleanPhone(document.getElementById('custPhone').value);
    const notes = document.getElementById('custNotes').value.trim() || 'None';

    if (name.length < 2) { alert('Please enter your full name.'); return; }
    if (!PHONE_RE.test(phone)) { alert(CFG.locale.phoneError); return; }
    if (!holdToken) { alert('Your ' + HOLD_MINS + '-minute hold has expired. Please choose a time again.'); goToStep(3); renderTimeSlots(); return; }

    submitBtn.disabled = true; label.innerText = 'Confirming…';
    const refCode = CFG.brand.refPrefix + Math.floor(100000 + Math.random() * 900000);

    const { data, error } = await sb.rpc('confirm_booking', {
        p_token: holdToken,
        p_ref: refCode,
        p_loc_name: bookingState.location.name,
        p_service_id: bookingState.service.id,
        p_service_name: bookingState.service.name + ' (' + bookingState.selectedOption.duration + ' Mins)',
        p_price: bookingState.selectedOption.price,
        p_name: name,
        p_phone: phone,
        p_notes: notes,
        p_source: 'online',
        p_created_by: null
    });

    submitBtn.disabled = false; label.innerText = 'Confirm Booking via WhatsApp';

    if (error || data !== 'ok') {
        if (data === 'expired') {
            holdToken = null; stopHoldCountdown();
            alert('Your hold expired. Please pick a time again.');
            goToStep(3); renderTimeSlots();
        } else {
            alert('Could not save your booking. Please check your internet and try again.');
        }
        return;
    }

    holdToken = null; stopHoldCountdown();
    bookingState.refCode = refCode;
    bookingState.customer = { name, phone, notes };

    const waMsg =
'*NEW APPOINTMENT BOOKING*\n' +
'----------------------------------------\n' +
'*Ref Code:* ' + refCode + '\n' +
'*' + CFG.labels.location + ':* ' + bookingState.location.name + '\n' +
'*Service:* ' + bookingState.service.name + ' (' + bookingState.selectedOption.duration + ' Mins)\n' +
'*Date:* ' + bookingState.date + '\n' +
'*Time Slot:* ' + bookingState.timeSlot + '\n' +
'*Price:* ' + money(bookingState.selectedOption.price) + '\n\n' +
'*GUEST DETAILS:*\n' +
'*Name:* ' + name + '\n' +
'*Phone:* ' + CFG.locale.dialCode + ' ' + phone + '\n' +
'*Chat:* https://wa.me/' + CFG.locale.countryCode + phone + '\n' +
'*Notes:* ' + notes + '\n' +
'----------------------------------------\n' +
'This slot is now locked in the scheduler.';

    document.getElementById('succRef').innerText     = refCode;
    document.getElementById('succLoc').innerText     = bookingState.location.name;
    document.getElementById('succService').innerText = bookingState.service.name;
    document.getElementById('succTime').innerText    = bookingState.date + ' @ ' + bookingState.timeSlot;

    window.open('https://api.whatsapp.com/send?phone=' + bookingState.location.phone + '&text=' + encodeURIComponent(waMsg), '_blank');
    goToStep(5);
}

/* ============================================================
   11. .ICS CALENDAR FILE
   ============================================================ */
function downloadCalendarEvent() {
    if (!bookingState.date || bookingState.startMinutes == null) return;
    const [y, m, d] = bookingState.date.split('-').map(Number);
    const startLocal = new Date(y, m - 1, d, Math.floor(bookingState.startMinutes / 60), bookingState.startMinutes % 60);
    const endLocal   = new Date(startLocal.getTime() + bookingState.selectedOption.duration * 60000);
    const utc = dt => dt.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

    const ics =
'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//' + CFG.brand.calendarProdId + '//Booking Engine//EN\r\nBEGIN:VEVENT\r\n' +
'UID:' + bookingState.refCode + '@' + CFG.brand.calendarUidDomain + '\r\n' +
'DTSTAMP:' + utc(new Date()) + '\r\n' +
'DTSTART:' + utc(startLocal) + '\r\n' +
'DTEND:' + utc(endLocal) + '\r\n' +
'SUMMARY:' + bookingState.service.name + ' - ' + CFG.brand.name + '\r\n' +
'DESCRIPTION:Appointment at ' + bookingState.location.name + '. Ref: ' + bookingState.refCode + '\r\n' +
'LOCATION:' + bookingState.location.address + '\r\n' +
'STATUS:CONFIRMED\r\nEND:VEVENT\r\nEND:VCALENDAR';

    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8;' }));
    link.download = CFG.brand.icsFilePrefix + bookingState.refCode + '.ics';
    document.body.appendChild(link); link.click(); link.remove();
}

async function resetApp() {
    await releaseHold();
    bookingState = { step: 1, location: null, service: null, selectedOption: null,
                     date: null, timeSlot: null, startMinutes: null, customer: {} };
    document.getElementById('bookingForm').reset();
    generateDates();
        SERVICES = DEFAULT_MENU;
    renderCategories();
    renderServices('All');
    goToStep(1);
}

/* ============================================================
   12. DAY VIEW CONSOLE  (staff only — needs Supabase login)
   ============================================================ */
let DV = { date: null, branch: 'all', rows: [] };

const aLocId = () => document.getElementById('aLoc').value;
function dvInitPickers() {
    const today = ymdLocal(new Date());
    document.getElementById('dvDate').value = today;
    document.getElementById('aDate').value  = today;
    document.getElementById('dvBranch').innerHTML = '<option value="all">All branches</option>' +
        LOCATIONS.map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join('');
    document.getElementById('aLoc').innerHTML =
        LOCATIONS.map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join('');
    dvFillSrv();

    const nm = nowMins();
    document.getElementById('aTime').value = pad2(Math.floor(nm / 60)) + ':' + pad2(nm % 60);

    document.getElementById('aLoc').onchange  = () => { dvFillSrv(); aUpdateEnds(); aTherRefresh(); };
    document.getElementById('aSrv').onchange  = () => { aUpdateEnds(); aTherRefresh(); };
    document.getElementById('aTime').oninput  = () => { aUpdateEnds(); aTherRefresh(); };
    document.getElementById('aDate').onchange = aTherRefresh;
    aUpdateEnds();

    document.getElementById('dvDate').onchange   = dvLoad;
    document.getElementById('dvBranch').onchange = dvLoad;
    thInit();

    document.addEventListener('keydown', e => {
        if (e.shiftKey && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') { e.preventDefault(); dvGate(); }
    });
    if (location.hash === '#staff') setTimeout(dvGate, 300);
    window.addEventListener('hashchange', () => { if (location.hash === '#staff') dvGate(); });
}
/* "13:10" -> 790 minutes. Returns null if blank/invalid. */
function textToMins(v) {
    if (!v) return null;
    const p = String(v).split(':');
    const h = Number(p[0]), m = Number(p[1]);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    return h * 60 + m;
}

/* Live "ends 2:10 PM" preview under the staff time field. */
function aUpdateEnds() {
    const el = document.getElementById('aEnds');
    if (!el) return;
    const start = textToMins(document.getElementById('aTime').value);
    const dur   = Number((document.getElementById('aSrv').value || '').split('|')[1]);
    if (start === null || !dur) { el.innerText = 'ends --'; el.className = 'text-[11px] text-sand-800 whitespace-nowrap'; return; }
    const end = start + dur;
    el.innerText = 'ends ' + minsToText(end) + ' (' + dur + 'm)';
    el.className = 'text-[11px] whitespace-nowrap font-semibold ' +
        (end > closeOf(aLocId()) || start < openOf(aLocId()) ? 'text-rose-700' : 'text-emerald-700');
}
function dvFillSrv() {
    const list = menuFor(document.getElementById('aLoc').value);
    document.getElementById('aSrv').innerHTML = list.flatMap(s =>
        s.options.map(o => `<option value="${s.id}|${o.duration}|${o.price}">${esc(s.name)} — ${o.duration}m — ${money(o.price)}</option>`)).join('');
}

async function dvGate() {
    let session = (await sb.auth.getSession()).data.session;
    if (!session) {
        const email = prompt('Staff email'); if (!email) return;
        const password = prompt('Password');  if (!password) return;
        const { error } = await sb.auth.signInWithPassword({ email: email.trim(), password });
        if (error) { alert('Login failed: ' + error.message); return; }
    }
    document.getElementById('dvModal').classList.remove('hidden');
    dvLoad();
}
function dvClose() {
    document.getElementById('dvModal').classList.add('hidden');
    if (location.hash === '#staff') history.replaceState(null, '', location.pathname);
}
async function dvLogout() {
    await sb.auth.signOut();
    dvClose();
    alert('Logged out.');
}
function dvShowAdd() { document.getElementById('dvAdd').classList.toggle('hidden'); }

async function dvLoad() {
    DV.date   = document.getElementById('dvDate').value || ymdLocal(new Date());
    DV.branch = document.getElementById('dvBranch').value;
    document.getElementById('dvGrid').innerHTML = '<div class="p-6 text-sand-800">Loading…</div>';

    let q = sb.from('bookings').select('*').eq('date', DV.date).eq('kind', 'booking');
    if (DV.branch !== 'all') q = q.eq('loc_id', DV.branch);
    const { data, error } = await q;

    if (error) {
        document.getElementById('dvGrid').innerHTML =
            '<div class="p-6 text-red-700">Could not load. You may need to log in again. (' + esc(error.message) + ')</div>';
        return;
    }
    DV.rows = (data || []).sort((a, b) => a.start_min - b.start_min);
    dvKpi(); dvGrid(); dvList(); thLoad();
}

function dvKpi() {
    const live = DV.rows.filter(b => b.status === 'confirmed');
    const rev = live.reduce((s, b) => s + (b.price || 0), 0);
    const isToday = DV.date === ymdLocal(new Date());
    const n = nowMins();
    const busy = live.filter(b => b.start_min <= n && b.end_min > n).length;
    const total = DV.branch === 'all' ? LOCATIONS.reduce((s, l) => s + capOf(l.id), 0) : capOf(DV.branch);
    const card = (a, b, c) => `<div class="bg-white border border-sand-200 rounded-xl p-3">
        <div class="text-[10px] uppercase tracking-wide text-sand-800">${a}</div>
        <div class="text-xl font-extrabold text-brand-900">${b}</div>
        <div class="text-[10px] text-sand-800">${c}</div></div>`;
    document.getElementById('dvKpi').innerHTML =
        card('Bookings', live.length, (DV.rows.length - live.length) + ' cancelled / no-show') +
        card('Revenue', money(rev), 'expected for the day') +
        card('Phone / walk-in', live.filter(b => b.source !== 'online').length, 'of ' + live.length + ' total') +
        card('In session now', isToday ? busy + ' / ' + total : '—', isToday ? 'rooms occupied' : 'not today');
}

function dvGrid() {
    const live = DV.rows.filter(b => b.status === 'confirmed');
    const times = [];
    const hrs = DV.branch === 'all'
        ? { open: Math.min(...LOCATIONS.map(l => openOf(l.id))), close: Math.max(...LOCATIONS.map(l => closeOf(l.id))) }
        : { open: openOf(DV.branch), close: closeOf(DV.branch) };
    for (let t = hrs.open; t < hrs.close; t += SLOT_STEP) times.push(t);
    const isToday = DV.date === ymdLocal(new Date());
    const n = nowMins();
    let head, body;

    if (DV.branch === 'all') {
        head = LOCATIONS.map(l => `<th class="px-2 py-1.5 font-bold text-brand-900 whitespace-nowrap">${esc(l.shortName || l.name)}</th>`).join('');
        body = times.map(t => {
            const rowCls = isToday && n >= t && n < t + SLOT_STEP ? 'bg-amber-50' : '';
            return `<tr class="${rowCls}"><td class="px-2 py-1 text-sand-800 whitespace-nowrap border-t border-sand-100">${minsToText(t)}</td>` +
                LOCATIONS.map(l => {
                    const c = live.filter(b => b.loc_id === l.id && b.start_min < t + SLOT_STEP && b.end_min > t).length;
                    const k = capOf(l.id);
                    const cls = c === 0 ? 'bg-white text-sand-800' : (c >= k ? 'bg-rose-100 text-rose-900 font-bold' : 'bg-emerald-50 text-emerald-900 font-semibold');
                    return `<td class="px-2 py-1 text-center border-t border-l border-sand-100 ${cls}">${c}/${k}</td>`;
                }).join('') + '</tr>';
        }).join('');
    } else {
        const k = capOf(DV.branch);
        head = Array.from({ length: k }, (_, i) => `<th class="px-2 py-1.5 font-bold text-brand-900">Room ${i + 1}</th>`).join('');
        body = times.map(t => {
            const rowCls = isToday && n >= t && n < t + SLOT_STEP ? 'bg-amber-50' : '';
            return `<tr class="${rowCls}"><td class="px-2 py-1 text-sand-800 whitespace-nowrap border-t border-sand-100">${minsToText(t)}</td>` +
                Array.from({ length: k }, (_, i) => {
                    const b = live.find(x => (x.room_no || 1) === i + 1 && x.start_min < t + SLOT_STEP && x.end_min > t);
                    if (!b) return '<td class="px-2 py-1 border-t border-l border-sand-100 bg-white"></td>';
                    const first = b.start_min >= t && b.start_min < t + SLOT_STEP;
                    return `<td class="px-2 py-1 border-t border-l border-sand-100 bg-emerald-100 text-emerald-900">` +
                            (first ? `<div class="font-bold leading-tight">${minsToText(b.start_min)} ${esc(String(b.name || '').split(' ')[0])}</div>
                                  <div class="leading-tight">${esc(String(b.service_name || '').slice(0, 20))}</div>` : '') + '</td>';
                }).join('') + '</tr>';
        }).join('');
    }

    document.getElementById('dvGrid').innerHTML = `<table class="border-collapse w-full">
        <thead><tr class="bg-sand-100"><th class="px-2 py-1.5 text-left text-sand-800">Time</th>${head}</tr></thead>
        <tbody>${body}</tbody></table>`;
}

function dvList() {
    if (!DV.rows.length) {
        document.getElementById('dvList').innerHTML =
            '<div class="bg-white border border-sand-200 rounded-xl p-6 text-center text-sand-800 text-sm">No bookings for this day.</div>';
        return;
    }
    document.getElementById('dvList').innerHTML = DV.rows.map(b => {
        const dead = b.status !== 'confirmed';
        const tag = b.status === 'cancelled' ? 'bg-rose-100 text-rose-800'
                  : b.status === 'noshow'    ? 'bg-amber-100 text-amber-800'
                                             : 'bg-emerald-100 text-emerald-800';
        return `<div class="bg-white border border-sand-200 rounded-xl p-3 ${dead ? 'opacity-55' : ''}">
            <div class="flex flex-wrap items-center gap-2 text-xs">
                <span class="font-extrabold text-brand-900">${minsToText(b.start_min)}–${minsToText(b.end_min)}</span>
                <span class="px-2 py-0.5 rounded-full ${tag} font-semibold">${esc(b.status)}</span>
                <span class="px-2 py-0.5 rounded-full bg-sand-100 text-sand-800">${esc(b.source)}</span>
                <span class="px-2 py-0.5 rounded-full bg-sand-100 text-sand-800">Room ${b.room_no || 1}</span>
                <span class="px-2 py-0.5 rounded-full ${b.therapist_name ? 'bg-indigo-100 text-indigo-800 font-semibold' : 'bg-amber-100 text-amber-800'}">${b.therapist_name ? esc(b.therapist_name) : 'no therapist'}</span>
                <span class="ml-auto font-mono text-sand-800">${esc(b.ref || '--')}</span>
            </div>
            <div class="mt-1 text-sm font-bold text-brand-900">${esc(b.name)} · ${esc(b.service_name)}</div>
            <div class="text-xs text-sand-800">${esc(b.loc_name)} · ${b.duration} mins · ${money(b.price)}${b.notes && b.notes !== 'None' ? ' · ' + esc(b.notes) : ''}</div>
            <div class="mt-2 flex flex-wrap gap-2 no-print">
                <a href="tel:${CFG.locale.dialCode}${esc(b.phone)}" class="px-2.5 py-1 bg-brand-100 text-brand-800 rounded-lg text-[11px] font-semibold">Call</a>
                <a href="https://wa.me/${CFG.locale.countryCode}${esc(b.phone)}" target="_blank" class="px-2.5 py-1 bg-emerald-100 text-emerald-800 rounded-lg text-[11px] font-semibold">WhatsApp</a>
                ${dead ? '' : `<button onclick="dvAssign('${b.id}')" class="px-2.5 py-1 bg-indigo-100 text-indigo-800 rounded-lg text-[11px] font-semibold">${b.therapist_name ? 'Change therapist' : 'Assign therapist'}</button>`}
                ${dead ? '' : `<button onclick="dvMark('${b.id}','noshow')" class="px-2.5 py-1 bg-amber-100 text-amber-800 rounded-lg text-[11px] font-semibold">No-show</button>
                <button onclick="dvMark('${b.id}','cancelled')" class="px-2.5 py-1 bg-rose-100 text-rose-800 rounded-lg text-[11px] font-semibold">Cancel</button>`}
            </div></div>`;
    }).join('');
}

async function dvMark(id, status) {
    const b = DV.rows.find(r => r.id === id); if (!b) return;
    if (!confirm('Mark ' + b.name + ' at ' + minsToText(b.start_min) + ' as ' + status + '?')) return;
    const { error } = await sb.from('bookings').update({ status }).eq('id', id);
    if (error) { alert('Could not save: ' + error.message); return; }
    dvLoad();
}

async function dvAddBooking(btn) {
    const locId = document.getElementById('aLoc').value;
    const loc   = LOCATIONS.find(l => l.id === locId);
    const [sid, durStr, priceStr] = document.getElementById('aSrv').value.split('|');
    const srv   = menuFor(locId).find(s => s.id === sid);
    const duration = Number(durStr), price = Number(priceStr);
    const date  = document.getElementById('aDate').value;
    const start = textToMins(document.getElementById('aTime').value);
    const name  = document.getElementById('aName').value.trim();
    const phone = cleanPhone(document.getElementById('aPhone').value);
    const source= document.getElementById('aSource').value;
    const notes = document.getElementById('aNotes').value.trim() || 'None';
    const therId= document.getElementById('aTher').value || null;
    const ther  = (TH.cands || []).find(c => c.id === therId);

    if (name.length < 2) { alert('Enter the guest name.'); return; }
    if (!PHONE_RE.test(phone)) { alert(CFG.locale.phoneErrorStaff); return; }
    if (start === null) { alert('Enter a start time.'); return; }
    if (start < openOf(locId)) { alert('We open at ' + minsToText(openOf(locId)) + '. Pick a later start.'); return; }
    if (start + duration > closeOf(locId)) { alert('That session would run past ' + minsToText(closeOf(locId)) + '.'); return; }

    btn.disabled = true; btn.innerText = 'Saving…';
    const ref = CFG.brand.refPrefix + Math.floor(100000 + Math.random() * 900000);
    const who = (await sb.auth.getUser()).data.user?.email || 'staff';
    let newId = null, hardError = null;

    for (let room = 1; room <= capOf(locId); room++) {
        const { data, error } = await sb.from('bookings').insert({
            kind: 'booking', status: 'confirmed', ref: ref,
            loc_id: locId, loc_name: loc.name,
            service_id: srv.id, service_name: srv.name + ' (' + duration + ' Mins)',
            duration: duration, price: price,
            date: date, start_min: start, end_min: start + duration, room_no: room,
            name: name, phone: phone, notes: notes, source: source,
            created_by: who
        }).select('id').single();
        if (!error) { newId = data.id; break; }
        if (error.code !== '23P01') { hardError = error.message; break; }
    }

    btn.disabled = false; btn.innerText = 'Save booking';
    if (hardError) { alert('Could not save: ' + hardError); return; }
    if (!newId)    { alert('All rooms are busy at that time. Pick another slot.'); return; }

    let msg = 'Booked. Ref ' + ref;
    if (therId) {
        const { data, error } = await sb.rpc('assign_therapist', { p_booking_id: newId, p_therapist_id: therId });
        if (error)          msg += '\n\n⚠️ Saved, but therapist not assigned: ' + error.message;
        else if (data === 'ok') msg += '\nTherapist: ' + (ther ? ther.name : '');
        else                msg += '\n\n⚠️ Saved WITHOUT a therapist — ' + thReason(data) + '\nAssign someone else from the list below.';
    }
    alert(msg);

    document.getElementById('aName').value = '';
    document.getElementById('aPhone').value = '';
    document.getElementById('aNotes').value = '';
    document.getElementById('dvDate').value = date;
    dvLoad();
}

function dvCsv() {
    const cols = ['ref','date','start','end','loc_name','service_name','duration','price','room_no','therapist_name','name','phone','status','source','created_by','notes'];
    const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const body = DV.rows.map(r => cols.map(c =>
        q(c === 'start' ? minsToText(r.start_min) : c === 'end' ? minsToText(r.end_min) : r[c])).join(',')).join('\n');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([cols.join(',') + '\n' + body], { type: 'text/csv;charset=utf-8;' }));
    link.download = CFG.brand.csvFilePrefix + DV.branch + '_' + DV.date + '.csv';
    document.body.appendChild(link); link.click(); link.remove();
}

/* ============================================================
   13. THERAPIST ATTENDANCE + AUTOMATIC ALLOCATION
   ============================================================ */
/* TH_MAX comes from the tenant config block at the top of this file. */
let TH = { date: null, loc: null, roster: [], bookings: [], cands: [] };
let aTherTimer = null;

function thShowAdd() { document.getElementById('thAdd').classList.toggle('hidden'); }
const aTherRefresh = () => { clearTimeout(aTherTimer); aTherTimer = setTimeout(aFillTherapists, 350); };

function thReason(code) {
    return ({
        busy:           'she already has an overlapping booking',
        on_leave:       'she is marked on leave for that date',
        not_arrived:    'she has not arrived by that time',
        shift_ended:    'that session runs past her shift end',
        not_registered: 'she is not on the roster for that centre and date',
        no_booking:     'the booking could not be found'
    })[code] || ('unexpected result: ' + code);
}

function thInit() {
    document.getElementById('tLoc').innerHTML =
        LOCATIONS.map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join('');
    document.getElementById('tLoc').onchange = thLoadDir;
    document.getElementById('tArr').value = pad2(Math.floor(RULES.openMin / 60)) + ':' + pad2(RULES.openMin % 60);
    setInterval(() => {
        if (!document.getElementById('dvModal').classList.contains('hidden')) thRenderGrid();
    }, 60000);
}

async function thLoadDir() {
    const loc = document.getElementById('tLoc').value;
    const { data } = await sb.from('therapists').select('name').eq('loc_id', loc).eq('active', true).order('name');
    document.getElementById('tDir').innerHTML = (data || []).map(d => `<option value="${esc(d.name)}"></option>`).join('');
}

async function thLoad() {
    TH.date = DV.date; TH.loc = DV.branch;
    const box = document.getElementById('thGrid');
    const cnt = document.getElementById('thCount');

    if (DV.branch === 'all') {
        TH.roster = [];
        cnt.innerText = '';
        box.innerHTML = '<div class="p-4 text-center text-sand-800">Pick a single centre above to see and manage its therapist roster.</div>';
        return;
    }
    box.innerHTML = '<div class="p-4 text-sand-800">Loading roster…</div>';

    const { data, error } = await sb.from('therapist_days')
        .select('id,therapist_id,arrival_min,shift_end_min,on_leave,seq,therapists(name)')
        .eq('loc_id', DV.branch).eq('date', DV.date);

    if (error) { box.innerHTML = '<div class="p-4 text-red-700">Could not load roster: ' + esc(error.message) + '</div>'; return; }

    TH.roster = (data || [])
        .map(r => ({ ...r, name: r.therapists ? r.therapists.name : '—' }))
        .sort((a, b) => a.arrival_min - b.arrival_min || (a.seq || 0) - (b.seq || 0));
    TH.bookings = DV.rows.filter(b => b.status === 'confirmed' && b.therapist_id);

    document.getElementById('tLoc').value = DV.branch;
    thLoadDir();
    thRenderGrid();
}

function thStatus(r) {
    const isToday = TH.date === ymdLocal(new Date());
    const n = nowMins();
    const ended = r.shift_end_min !== null;
    if (r.on_leave) return { label: 'On Leave', cls: 'bg-sand-100 text-sand-800', sub: '' };
    if (ended && (!isToday || n >= r.shift_end_min))
        return { label: 'On Leave', cls: 'bg-sand-100 text-sand-800', sub: 'shift ended ' + minsToText(r.shift_end_min) };
    if (!isToday) return { label: 'Available', cls: 'bg-emerald-100 text-emerald-800', sub: 'scheduled' };
    if (n < r.arrival_min) return { label: 'Not Arrived', cls: 'bg-amber-100 text-amber-800', sub: 'due ' + minsToText(r.arrival_min) };
    const live = TH.bookings.find(b => b.therapist_id === r.therapist_id && b.start_min <= n && b.end_min > n);
    if (live) return { label: 'Busy / In Session', cls: 'bg-rose-100 text-rose-800', sub: 'till ' + minsToText(live.end_min) };
    return { label: 'Available', cls: 'bg-emerald-100 text-emerald-800', sub: 'on duty' };
}

function thRenderGrid() {
    const box = document.getElementById('thGrid');
    const cnt = document.getElementById('thCount');
    if (TH.loc === 'all') return;
    cnt.innerText = TH.roster.length + ' of ' + TH_MAX + ' registered';

    if (!TH.roster.length) {
        box.innerHTML = '<div class="p-4 text-center text-sand-800">No therapists on the roster for this date. Use <strong>+ Add Therapist</strong>.</div>';
        return;
    }
    const rows = TH.roster.map(r => {
        const s = thStatus(r);
        const next = TH.bookings.filter(b => b.therapist_id === r.therapist_id).length;
        const endCell = r.shift_end_min === null
            ? `<span class="text-sand-800">on duty</span>
               <button onclick="thEndShift('${r.id}')" class="ml-1.5 px-2 py-0.5 rounded bg-brand-100 text-brand-800 font-semibold">End shift</button>`
            : `<span class="font-semibold">${minsToText(r.shift_end_min)}</span>
               <button onclick="thReopen('${r.id}')" class="ml-1.5 underline text-sand-800">reopen</button>`;
        return `<tr class="border-t border-sand-100">
            <td class="px-2 py-2 font-bold text-brand-900 whitespace-nowrap">${esc(r.name)}
                <span class="font-normal text-sand-800">· ${next} today</span></td>
            <td class="px-2 py-2 whitespace-nowrap">${minsToText(r.arrival_min)}</td>
            <td class="px-2 py-2 whitespace-nowrap">${endCell}</td>
            <td class="px-2 py-2 whitespace-nowrap">
                <span class="px-2 py-0.5 rounded-full font-semibold ${s.cls}">${s.label}</span>
                ${s.sub ? `<span class="text-sand-800 ml-1">${esc(s.sub)}</span>` : ''}
                <button onclick="thLeave('${r.id}',${r.on_leave ? 'false' : 'true'})" class="ml-2 underline text-sand-800">${r.on_leave ? 'back on duty' : 'mark on leave'}</button>
                <button onclick="thRemove('${r.id}','${esc(r.name)}')" class="ml-2 underline text-sand-800">remove</button>
            </td></tr>`;
    }).join('');

    box.innerHTML = `<table class="border-collapse w-full min-w-max">
        <thead><tr class="bg-sand-100 text-left text-sand-800">
            <th class="px-2 py-1.5">Therapist</th><th class="px-2 py-1.5">Arrival Time</th>
            <th class="px-2 py-1.5">Shift End Time</th><th class="px-2 py-1.5">Status</th>
        </tr></thead><tbody>${rows}</tbody></table>`;
}

async function thSave(btn) {
    const locId = document.getElementById('tLoc').value;
    const date  = document.getElementById('dvDate').value;
    const name  = document.getElementById('tName').value.trim().replace(/\s+/g, ' ');
    const arr   = textToMins(document.getElementById('tArr').value);

    if (name.length < 2) { alert('Enter the therapist name.'); return; }
    if (arr === null) { alert('Enter the arrival time.'); return; }

    btn.disabled = true; btn.innerText = 'Saving…';
    let tid = null;
    const found = await sb.from('therapists').select('id').eq('loc_id', locId).ilike('name', name).limit(1);
    if (found.data && found.data.length) tid = found.data[0].id;
    else {
        const ins = await sb.from('therapists').insert({ loc_id: locId, name: name }).select('id').single();
        if (ins.error) { btn.disabled = false; btn.innerText = 'Save therapist'; alert('Could not save: ' + ins.error.message); return; }
        tid = ins.data.id;
    }

    const { error } = await sb.from('therapist_days').insert({
    therapist_id: tid, loc_id: locId, date: date, arrival_min: arr, shift_end_min: null
    });
    btn.disabled = false; btn.innerText = 'Save therapist';

    if (error) {
        alert(error.code === '23505'
            ? name + ' is already on the roster for ' + date + '.'
            : 'Could not save: ' + error.message);
        return;
    }
    document.getElementById('tName').value = '';
    document.getElementById('dvBranch').value = locId;
    dvLoad(); aTherRefresh();
}

async function thLeave(dayId, val) {
    const r = TH.roster.find(x => x.id === dayId); if (!r) return;
    if (val && TH.bookings.some(b => b.therapist_id === r.therapist_id)) {
        if (!confirm(r.name + ' already has bookings today. Mark her on leave anyway? Those bookings stay assigned — reassign them from the list below.')) return;
    }
    const { error } = await sb.from('therapist_days').update({ on_leave: val }).eq('id', dayId);
    if (error) { alert('Could not update: ' + error.message); return; }
    dvLoad(); aTherRefresh();
}

async function thRemove(dayId, name) {
    if (!confirm('Remove ' + name + " from this date's roster?")) return;
    const { error } = await sb.from('therapist_days').delete().eq('id', dayId);
    if (error) { alert('Could not remove: ' + error.message); return; }
    dvLoad(); aTherRefresh();
}

async function thEndShift(dayId) {
    const r = TH.roster.find(x => x.id === dayId); if (!r) return;
    const nowTxt = minsToText(nowMins());

    if (!confirm('END SHIFT — ' + r.name + '\n\nLog her shift end at about ' + nowTxt +
                 '?\n\nShe will not be offered for any booking after that time today.\n\nClick OK only if she has actually left.')) return;

    let res = await sb.rpc('end_shift', { p_day_id: dayId, p_force: false });
    if (res.error) { alert('Could not end shift: ' + res.error.message); return; }

    if (String(res.data).startsWith('has_sessions:')) {
        const n = String(res.data).split(':')[1];
        if (!confirm('⚠️ ' + r.name + ' still has ' + n + ' session(s) running now or booked later today.\n\n' +
                     'Ending her shift will NOT cancel them — they stay assigned to her and must be reassigned from the booking list.\n\n' +
                     'End her shift anyway?')) return;
        res = await sb.rpc('end_shift', { p_day_id: dayId, p_force: true });
        if (res.error) { alert('Could not end shift: ' + res.error.message); return; }
    }

    const code = String(res.data);
    if (code.startsWith('ok:')) alert(r.name + "'s shift ended at " + minsToText(Number(code.split(':')[1])) + '.');
    else if (code === 'not_today')      alert('Shift end can only be logged on the actual day. Switch the date to today.');
    else if (code === 'before_arrival') alert('The current time is before her arrival time. Remove her from the roster instead.');
    else if (code === 'not_found')      alert('That roster entry no longer exists.');
    else                                alert('Unexpected result: ' + code);

    dvLoad(); aTherRefresh();
}

async function thReopen(dayId) {
    const r = TH.roster.find(x => x.id === dayId); if (!r) return;
    if (!confirm('Reopen ' + r.name + "'s shift?\n\nThe logged end time of " + minsToText(r.shift_end_min) +
                 ' will be cleared and she becomes available for bookings again.')) return;
    const { error } = await sb.from('therapist_days').update({ shift_end_min: null }).eq('id', dayId);
    if (error) { alert('Could not reopen: ' + error.message); return; }
    dvLoad(); aTherRefresh();
}

/* ---- eligibility for one specific appointment interval ---- */
async function thCandidates(locId, date, start, dur) {
    const end = start + dur;
    const [rosterRes, bkRes] = await Promise.all([
        sb.from('therapist_days')
          .select('therapist_id,arrival_min,shift_end_min,on_leave,seq,therapists(name)')
          .eq('loc_id', locId).eq('date', date),
        sb.from('bookings')
          .select('therapist_id,start_min,end_min')
          .eq('loc_id', locId).eq('date', date).eq('kind', 'booking')
          .eq('status', 'confirmed').not('therapist_id', 'is', null)
    ]);
    const bk = bkRes.data || [];
    return (rosterRes.data || []).map(r => {
        let why = '';
        if (r.on_leave)                 why = 'on leave';
        else if (start < r.arrival_min) why = 'arrives ' + minsToText(r.arrival_min);
        else if (r.shift_end_min !== null && end > r.shift_end_min) why = 'shift ended ' + minsToText(r.shift_end_min);
        else {
            const clash = bk.find(b => b.therapist_id === r.therapist_id && b.start_min < end && b.end_min > start);
            if (clash) why = 'busy ' + minsToText(clash.start_min) + '–' + minsToText(clash.end_min);
        }
        return { id: r.therapist_id, name: r.therapists ? r.therapists.name : '—',
                 arrival: r.arrival_min, seq: r.seq || 0, ok: !why, why: why };
    }).sort((a, b) => a.arrival - b.arrival || a.seq - b.seq);
}

/* ---- auto-preselect the next therapist by arrival sequence ---- */
async function aFillTherapists() {
    const sel  = document.getElementById('aTher');
    const note = document.getElementById('aTherNote');
    if (!sel) return;
    const locId = document.getElementById('aLoc').value;
    const date  = document.getElementById('aDate').value;
    const start = textToMins(document.getElementById('aTime').value);
    const dur   = Number((document.getElementById('aSrv').value || '').split('|')[1]) || 60;

    if (!locId || !date || start === null) {
        sel.innerHTML = '<option value="">— No therapist —</option>';
        note.innerHTML = '&nbsp;'; return;
    }
    sel.innerHTML = '<option value="">Checking…</option>';
    TH.cands = await thCandidates(locId, date, start, dur);
    const free = TH.cands.filter(c => c.ok);

    sel.innerHTML = '<option value="">— No therapist —</option>' +
        TH.cands.map(c => `<option value="${c.id}"${c.ok ? '' : ' disabled'}>${esc(c.name)} · ${minsToText(c.arrival)}${c.ok ? '' : ' — ' + esc(c.why)}</option>`).join('');

    if (free.length) {
        sel.value = free[0].id;
        note.innerText = 'Auto-assigned: ' + free[0].name + ' (next by arrival). Change it if the guest asked for someone.';
        note.className = 'text-[11px] text-emerald-700 font-semibold mt-1';
    } else {
        note.innerText = TH.cands.length
            ? 'No therapist is free for ' + minsToText(start) + '–' + minsToText(start + dur) + '.'
            : 'No therapists on the roster for this centre and date.';
        note.className = 'text-[11px] text-rose-700 font-semibold mt-1';
    }
}

/* ---- assign or change the therapist on an existing booking ---- */
async function dvAssign(id) {
    const b = DV.rows.find(r => r.id === id); if (!b) return;
    const cands = await thCandidates(b.loc_id, b.date, b.start_min, b.duration);
    if (!cands.length) { alert('No therapists are on the roster for ' + b.loc_name + ' on ' + b.date + '.'); return; }

    const list = cands.map((c, i) => (i + 1) + '. ' + c.name + ' (' + minsToText(c.arrival) + ') — ' + (c.ok ? 'FREE' : c.why)).join('\n');
    const pick = prompt('Assign a therapist to ' + b.name + ', ' + minsToText(b.start_min) + '–' + minsToText(b.end_min) +
                        '\n\n' + list + '\n\nType the number, or 0 to unassign:');
    if (pick === null) return;
    const idx = Number(pick);
    if (!Number.isInteger(idx) || idx < 0 || idx > cands.length) { alert('That is not a valid number.'); return; }
    const t = idx === 0 ? null : cands[idx - 1];

    const { data, error } = await sb.rpc('assign_therapist', { p_booking_id: id, p_therapist_id: t ? t.id : null });
    if (error) { alert('Could not assign: ' + error.message); return; }
    if (data !== 'ok') { alert('Not assigned — ' + thReason(data) + '.'); return; }
    dvLoad();
}
