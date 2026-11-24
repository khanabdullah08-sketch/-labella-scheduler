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

/* Two database flavours share this engine:
   legacy = the original single-tenant project (browser sends room count / price, fixed hours);
   v2     = shared multi-tenant project (database decides rooms, hours, price, reference). */
const V2 = CFG.backend === 'v2';
const TENANT = CFG.tenant;

/* Optional staff-console features, switched per client in tenant.json ("features"). Anything missing = off. */
const FEATURES = Object.assign({ addons: false, roomAssign: false, adjustSession: false }, CFG.features || {});
const ADDON_MAX = 100000;                    // same limit as the database (bookings.addon_amt)
const DUR_MIN = 15, DUR_MAX = 240;           // custom session length limits (adjust_session)

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
/* The menus baked into the page (catalog.json) are only the starting point / offline fallback.
   On the v2 backend loadLiveCatalog() replaces them with the live prices from get_catalog(). */
let MENU_LIST = CFG.menus;
let MENUS = {};
const indexMenus = () => { MENUS = Object.fromEntries(LOCATIONS.map(l => [l.id, MENU_LIST[l.menu]])); };
indexMenus();
const defaultMenu = () => MENU_LIST[CFG.defaultMenu] || [];
const menuFor = id => MENUS[id] || defaultMenu();

/* Active menu — swapped when the guest picks a branch. Must be `let`, not `const`. */
let SERVICES = defaultMenu();

/** Fetch the live menu + prices (v2 only). Returns true when the page now shows live data.
 *  Any failure keeps the baked-in menu, so the page still works; the database refuses a stale price anyway. */
async function loadLiveCatalog() {
    if (!V2) return false;
    try {
        const { data, error } = await sb.rpc('get_catalog', { p_slug: TENANT });
        if (error || !data || !data.menus || typeof data.menus !== 'object') return false;
        const live = {};
        for (const [code, list] of Object.entries(data.menus)) {
            live[code] = (Array.isArray(list) ? list : [])
                .map(s => ({ ...s, options: (Array.isArray(s.options) ? s.options : [])
                    .map(o => ({ duration: Number(o.duration), price: Number(o.price) })) }))
                .filter(s => s.options.length > 0);          // every duration switched off = treatment hidden
        }
        MENU_LIST = { ...CFG.menus, ...live };
        indexMenus();
        SERVICES = bookingState.location ? menuFor(bookingState.location.id) : defaultMenu();
        if (bookingState.step <= 2) { renderCategories(); renderServices('All'); }
        dvFillSrv();
        return true;
    } catch (e) {
        console.warn('Live menu unavailable, using the built-in menu.', e);
        return false;
    }
}



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
    loadLiveCatalog();
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

    const { data, error } = V2
        ? await sb.rpc('get_busy_v2', {
            p_tenant: TENANT,
            p_branch: bookingState.location.id,
            p_date: bookingState.date,
            p_token: holdToken
        })
        : await sb.rpc('get_busy', {
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

/* Plain-English text for the codes the hold functions return. */
function holdMessage(code) {
    if (!V2 && code !== 'full') code = 'error';      // the legacy database only ever returns 'full'
    return ({
        full:          'Sorry — that slot was just taken by someone else. Please pick another time.',
        toosoon:       'That time is too soon to book online. Please pick a later slot.',
        closed:        'That time is outside our opening hours. Please pick another slot.',
        baddate:       'That date is not open for booking. Please pick another date.',
        price_changed: 'Our prices were just updated. Please refresh the page and choose your treatment again.'
    })[code] || 'Could not hold that slot. Please check your internet and try again.';
}
async function selectTimeSlot(startMinutes, btnEl) {
    document.getElementById('timeNextBtn').disabled = true;
    const original = btnEl.innerText;
    btnEl.innerText = '…';
    await releaseHold();

    const token = 'h-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
    const { data, error } = V2
        ? await sb.rpc('create_hold_v2', {
            p_tenant: TENANT,
            p_branch: bookingState.location.id,
            p_date: bookingState.date,
            p_start: startMinutes,
            p_service: bookingState.service.id,
            p_duration: bookingState.selectedOption.duration,
            p_token: token,
            p_price_seen: bookingState.selectedOption.price
        })
        : await sb.rpc('create_hold', {
            p_loc: bookingState.location.id,
            p_date: bookingState.date,
            p_start: startMinutes,
            p_duration: bookingState.selectedOption.duration,
            p_rooms: capOf(bookingState.location.id),
            p_token: token
        });

    if (error || data !== 'ok') {
        btnEl.innerText = original;
        alert(holdMessage(error ? 'error' : data));
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
    /* legacy: the reference is made here. v2: the database issues it (guaranteed unique). */
    let refCode = CFG.brand.refPrefix + Math.floor(100000 + Math.random() * 900000);
    let status, error;
    if (V2) {
        const res = await sb.rpc('confirm_booking_v2', {
            p_tenant: TENANT,
            p_token: holdToken,
            p_name: name,
            p_phone: phone,
            p_notes: notes
        });
        error = res.error;
        status = res.data ? res.data.status : undefined;
        if (status === 'ok') refCode = res.data.ref;
    } else {
        const res = await sb.rpc('confirm_booking', {
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
        error = res.error;
        status = res.data;
    }

    submitBtn.disabled = false; label.innerText = 'Confirm Booking via WhatsApp';

    if (error || status !== 'ok') {
        if (status === 'expired') {
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
    SERVICES = defaultMenu();
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
    document.getElementById('aAddonWrap').classList[FEATURES.addons ? 'remove' : 'add']('hidden');

    document.getElementById('aLoc').onchange  = () => { dvFillSrv(); aUpdateEnds(); aTherRefresh(); aTher2Refresh(); };
    document.getElementById('aSrv').onchange  = () => { aUpdateEnds(); aTherRefresh(); aTher2Refresh(); };
    document.getElementById('aTime').oninput  = () => { aUpdateEnds(); aTherRefresh(); aTher2Refresh(); };
    document.getElementById('aDate').onchange = () => { aTherRefresh(); aTher2Refresh(); };
    document.getElementById('aTher').onchange = aTher2Refresh;
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
    let role = null;
    if (V2) {
        const me = await sb.from('staff').select('role').limit(1);
        if (me.error || !(me.data && me.data.length)) {
            await sb.auth.signOut();
            dvApplyRole(null);
            alert('This account is not set up as staff for this site. Ask the owner to add you.');
            return;
        }
        role = me.data[0].role;
    }
    dvApplyRole(role);                       // shows the "Menu & Prices" tab for owner / manager only
    if (V2) await loadLiveCatalog();         // walk-in form uses today's live prices
    document.getElementById('dvModal').classList.remove('hidden');
    dvLoad();
}
function dvClose() {
    document.getElementById('dvModal').classList.add('hidden');
    if (location.hash === '#staff') history.replaceState(null, '', location.pathname);
}
async function dvLogout() {
    await sb.auth.signOut();
    dvApplyRole(null);                       // forget the role and any loaded price data
    dvClose();
    alert('Logged out.');
}
function dvShowAdd() { document.getElementById('dvAdd').classList.toggle('hidden'); }

/* ============================================================
   12b. MENU & PRICES  (owner / manager only, v2 backend)
   The tab is hidden for every other role. That is a convenience only — the real protection is
   the database: service_options can only be changed by owner / manager logins (RLS policy
   options_write). A blocked update returns ZERO rows (not an error), so mpSave checks for that.
   ============================================================ */
const MP_MAX_PRICE = 1000000;                 // same limit as the check constraint on service_options.price
let MP = { canEdit: false, view: 'day', model: null, rows: {}, form: null };
const MP_DUR_MIN = 5, MP_DUR_MAX = 480, MP_MAX_OPTS = 10;       // same limits as the database functions

const mpIsManager = role => role === 'owner' || role === 'manager';
const mpPriceOk = raw => /^\d{1,7}$/.test(String(raw).trim()) && Number(raw) >= 1 && Number(raw) <= MP_MAX_PRICE;
const mpDirty = r => Number(String(r.raw).trim()) !== r.orig.price || r.active !== r.orig.active;
const mpDirtyRows = () => Object.values(MP.rows).filter(mpDirty);

/** Called after login (role from the staff table) and after logout (role = null). */
function dvApplyRole(role) {
    MP.canEdit = V2 && mpIsManager(role);
    MP.model = null; MP.rows = {}; MP.form = null;
    expApplyRole(role);
    document.getElementById('mpBody').innerHTML = '';
    mpFormRender();
    document.getElementById('dvTabs').classList[MP.canEdit ? 'remove' : 'add']('hidden');
    mpShow('day');
}
function mpShow(which) {
    const prices = which === 'prices' && MP.canEdit;
    MP.view = prices ? 'prices' : 'day';
    document.getElementById('mpView').classList[prices ? 'remove' : 'add']('hidden');
    document.getElementById('dvView').classList[prices ? 'add' : 'remove']('hidden');
    document.getElementById('dvTools').classList[prices ? 'add' : 'remove']('hidden');
    document.getElementById('dvTools').classList[prices ? 'remove' : 'add']('contents');   // `contents` keeps the buttons in the toolbar row
    const on = 'px-3 py-1.5 rounded-lg text-xs font-bold bg-brand-800 text-white';
    const off = 'px-3 py-1.5 rounded-lg text-xs font-bold bg-brand-100 text-brand-800';
    document.getElementById('dvTabDay').className = prices ? off : on;
    document.getElementById('dvTabPrices').className = prices ? on : off;
}
function dvTab(which) {
    if (MP.view === 'prices' && which !== 'prices' && mpDirtyRows().length &&
        !confirm('You have unsaved price changes. Leave without saving?')) return;
    mpShow(which);
    if (MP.view === 'prices' && !MP.model) return mpLoad();
}

/** Read menus, treatments and durations (including switched-off ones) straight from the tables. */
async function mpLoad(force, keepEdits) {
    if (!MP.canEdit) return;
    if (force && !keepEdits && mpDirtyRows().length && !confirm('Reloading discards your unsaved price changes. Continue?')) return;
    const kept = keepEdits ? MP.rows : {};          // after adding a treatment, unsaved price edits stay on screen
    document.getElementById('mpBody').innerHTML = '<div class="p-6 text-sand-800 text-sm">Loading…</div>';
    const [m, s, o] = await Promise.all([
        sb.from('menus').select('id,code,name').order('name'),
        sb.from('services').select('id,menu_id,code,category,name,description,sort,active').order('sort').order('code'),
        sb.from('service_options').select('id,service_id,duration_min,price,active,sort').order('sort').order('duration_min')
    ]);
    const failed = m.error || s.error || o.error;
    if (failed) {
        document.getElementById('mpBody').innerHTML = '<div class="p-4 text-rose-700 text-sm">Could not load the menu: ' + esc(failed.message) + '</div>';
        return;
    }
    MP.model = { menus: m.data || [], services: s.data || [], options: o.data || [] };
    MP.rows = {};
    for (const op of MP.model.options) {
        const prev = kept[op.id];
        MP.rows[op.id] = { id: op.id, serviceId: op.service_id, duration: op.duration_min,
                           orig: { price: op.price, active: !!op.active },
                           raw: prev ? prev.raw : String(op.price), active: prev ? prev.active : !!op.active };
    }
    mpRender();
}
function mpRender() {
    if (!MP.model) return;
    const { menus, services, options } = MP.model;
    // order the menus the way the branches are listed, and name each group after its branches
    const rank = code => { const i = LOCATIONS.findIndex(l => l.menu === code); return i < 0 ? 999 : i; };
    const html = [...menus].sort((a, b) => rank(a.code) - rank(b.code)).map(menu => {
        const branches = LOCATIONS.filter(l => l.menu === menu.code).map(l => l.name);
        const items = services.filter(sv => sv.menu_id === menu.id).map(sv => {
            const opts = options.filter(op => op.service_id === sv.id);
            if (!opts.length) return '';
            return `<div class="py-2.5 border-t border-sand-200 first:border-t-0">
                <div class="text-xs font-bold text-brand-900">${esc(sv.name)}
                    <span class="font-normal text-sand-800">· ${esc(sv.category)}</span>
                    ${sv.active ? '' : '<span class="ml-1 px-1.5 py-0.5 bg-rose-100 text-rose-800 rounded text-[10px]">treatment switched off</span>'}
                    <button onclick="mpOpenDur('${esc(sv.id)}')" class="ml-2 underline font-semibold text-brand-600">+ duration</button>
                    <button onclick="mpOpenEdit('${esc(sv.id)}')" class="ml-1 underline font-semibold text-brand-600">edit details</button></div>
                <div class="mt-1.5 space-y-1.5">${opts.map(op => {
                    const r = MP.rows[op.id];
                    return `<div id="mpRow_${esc(op.id)}" class="flex items-center gap-3 text-xs rounded-lg px-2 py-1 ${mpDirty(r) ? 'bg-amber-50' : ''}">
                        <span class="w-16 text-sand-800">${r.duration} min</span>
                        <label class="flex items-center gap-1">${esc(CFG.locale.currencySymbol)}
                            <input type="number" min="1" max="${MP_MAX_PRICE}" step="1" inputmode="numeric" value="${esc(r.raw)}"
                                   oninput="mpEdit('${esc(op.id)}','price',this.value)" class="w-24 p-1.5 border border-sand-200 rounded-lg"></label>
                        <label class="flex items-center gap-1"><input type="checkbox" ${r.active ? 'checked' : ''}
                                   onchange="mpEdit('${esc(op.id)}','active',this.checked)"> Active</label>
                    </div>`;
                }).join('')}</div></div>`;
        }).join('');
        return `<div class="bg-white border border-sand-200 rounded-xl p-4">
            <div class="flex items-start justify-between gap-2"><div class="text-sm font-bold text-brand-900">${esc(branches.length ? branches.join(' · ') : menu.name)}</div>
                <button onclick="mpOpenAdd('${esc(menu.code)}')" class="px-2.5 py-1 bg-emerald-100 text-emerald-800 rounded-lg text-[11px] font-bold whitespace-nowrap">+ Add ${esc(CFG.labels.serviceSummary.toLowerCase())}</button></div>
            <div class="text-[11px] text-sand-800 mb-1">${esc(menu.name)}</div>${items}</div>`;
    }).join('');
    document.getElementById('mpBody').innerHTML = html || '<div class="p-4 text-sm text-sand-800">No menu found for this site.</div>';
    mpRefreshSave();
}
function mpRefreshSave() {
    const n = mpDirtyRows().length;
    const b = document.getElementById('mpSave');
    b.disabled = n === 0;
    b.innerText = n ? 'Save ' + n + ' change' + (n === 1 ? '' : 's') : 'Save changes';
}
function mpEdit(id, field, value) {
    const r = MP.rows[id];
    if (!r) return;
    if (field === 'price') r.raw = String(value);
    else r.active = !!value;
    const row = document.getElementById('mpRow_' + id);
    if (row) row.classList[mpDirty(r) ? 'add' : 'remove']('bg-amber-50');
    mpRefreshSave();
}

async function mpSave(btn) {
    const dirty = mpDirtyRows();
    if (!MP.canEdit || !dirty.length) return;
    const nameOf = r => {
        const sv = MP.model.services.find(x => x.id === r.serviceId);
        const menu = sv && MP.model.menus.find(x => x.id === sv.menu_id);
        const br = menu ? LOCATIONS.filter(l => l.menu === menu.code).map(l => l.shortName || l.name).join('/') : '';
        return (br ? br + ' · ' : '') + (sv ? sv.name : 'Treatment') + ' ' + r.duration + ' min';
    };
    const bad = dirty.filter(r => !mpPriceOk(r.raw));
    if (bad.length) {
        alert('Enter a whole-rupee price between 1 and ' + MP_MAX_PRICE.toLocaleString(CFG.locale.numberLocale) + ' for:\n' + bad.map(nameOf).join('\n'));
        return;
    }
    const lines = dirty.map(r => nameOf(r) + ': ' + money(r.orig.price) + ' → ' + money(Number(r.raw)) +
                                 (r.active !== r.orig.active ? (r.active ? '  (switched ON)' : '  (switched OFF)') : ''));
    if (!confirm('Save ' + dirty.length + ' change(s)? They go live on the booking page immediately.\n\n' + lines.join('\n'))) return;

    btn.disabled = true; btn.innerText = 'Saving…';
    const results = await Promise.all(dirty.map(async r => {
        const price = Number(String(r.raw).trim());
        const { data, error } = await sb.from('service_options').update({ price, active: r.active }).eq('id', r.id).select('id,price,active');
        if (error) return { r, ok: false, why: error.message };
        // a login without permission gets no error, just no row back
        if (!data || data.length !== 1) return { r, ok: false, why: 'not allowed (only an owner or manager can change prices)' };
        r.orig = { price: data[0].price, active: !!data[0].active };
        r.raw = String(data[0].price); r.active = !!data[0].active;
        return { r, ok: true };
    }));
    const failed = results.filter(x => !x.ok);
    for (const x of results) {
        const o = x.ok && MP.model.options.find(z => z.id === x.r.id);
        if (o) { o.price = x.r.orig.price; o.active = x.r.orig.active; }
    }
    mpRender();
    await loadLiveCatalog();                  // this page now shows the new prices too
    alert(failed.length
        ? (results.length - failed.length) + ' saved, ' + failed.length + ' NOT saved:\n' + failed.map(x => nameOf(x.r) + ' — ' + x.why).join('\n')
        : 'Saved. The booking page now shows the new prices.');
}
/* ---- 12c. add a treatment / add a duration / edit details (owner / manager) ----
   Each action is one database function call (manager_add_service, manager_add_option, manager_update_service)
   that validates everything and writes nothing if anything is wrong. The checks below only save a round trip. */
const MP_WHY = {
    forbidden: 'only an owner or manager can change the menu',
    badname: 'the name must be 2 to 80 characters',
    badcategory: 'the category must be 2 to 40 characters',
    baddescription: 'the description is too long (300 characters at most)',
    invalid_menu: 'that menu was not found',
    badoptions: 'add between 1 and ' + MP_MAX_OPTS + ' durations, each with minutes and a price',
    badduration: 'minutes must be a whole number from ' + MP_DUR_MIN + ' to ' + MP_DUR_MAX,
    badprice: 'the price must be a whole number from 1 to ' + MP_MAX_PRICE.toLocaleString(CFG.locale.numberLocale),
    dupduration: 'that duration already exists for this treatment (it may be switched off: tick Active instead)',
    dupname: 'a treatment with that name is already on the menu (it may be switched off)',
    toolong: 'that is longer than the branch is open',
    not_found: 'that treatment was not found'
};
const mpWhy = code => MP_WHY[code] || ('unexpected result: ' + code);
const mpIntOk = (raw, lo, hi) => /^\d{1,7}$/.test(String(raw).trim()) && Number(raw) >= lo && Number(raw) <= hi;

function mpOpenAdd(menuCode) {
    if (!MP.canEdit || !MP.model) return;
    const menu = MP.model.menus.find(m => m.code === menuCode); if (!menu) return;
    MP.form = { kind: 'add', menus: [menuCode], category: '', name: '', desc: '', opts: [{ d: '', p: '' }] };
    mpFormRender();
}
function mpOpenDur(serviceId) {
    if (!MP.canEdit || !MP.model) return;
    if (!MP.model.services.find(s => s.id === serviceId)) return;
    MP.form = { kind: 'dur', serviceId, d: '', p: '' };
    mpFormRender();
}
function mpOpenEdit(serviceId) {
    if (!MP.canEdit || !MP.model) return;
    const s = MP.model.services.find(x => x.id === serviceId); if (!s) return;
    MP.form = { kind: 'edit', serviceId, category: s.category, name: s.name, desc: s.description || '', active: !!s.active };
    mpFormRender();
}
function mpFormCancel() { MP.form = null; mpFormRender(); }
/** Keep what is typed in the form (it is re-rendered when a row is added or removed). */
function mpFormSet(field, value, idx) {
    const f = MP.form; if (!f) return;
    if (field === 'd' || field === 'p') { if (f.kind === 'add') f.opts[idx][field] = value; else f[field] = value; }
    else if (field === 'active') f.active = !!value;
    else f[field] = value;
}
function mpFormToggleMenu(code, on) {
    const f = MP.form; if (!f || f.kind !== 'add') return;
    f.menus = on ? [...new Set([...f.menus, code])] : f.menus.filter(c => c !== code);
}
function mpFormRow(add) {
    const f = MP.form; if (!f || f.kind !== 'add') return;
    if (add && f.opts.length < MP_MAX_OPTS) f.opts.push({ d: '', p: '' });
    else if (!add && f.opts.length > 1) f.opts.pop();
    mpFormRender();
}

const MP_IN = 'p-2 border border-sand-200 rounded-lg text-xs';
function mpFormRender() {
    const box = document.getElementById('mpForm'); const f = MP.form;
    if (!f || !MP.model) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    const cur = esc(CFG.locale.currencySymbol);
    const head = t => `<div class="flex items-center justify-between"><strong class="text-sm text-brand-900">${t}</strong>
        <button onclick="mpFormCancel()" class="text-xs text-sand-800 underline">Cancel</button></div>`;
    const foot = (fn, label) => `<button onclick="${fn}(this)" class="w-full py-2.5 bg-emerald-700 text-white font-bold rounded-lg text-xs">${label}</button>`;
    let html = '';
    if (f.kind === 'add') {
        const cats = [...new Set(MP.model.services.map(s => s.category))].sort();
        const menuBoxes = MP.model.menus.map(m => {
            const br = LOCATIONS.filter(l => l.menu === m.code).map(l => l.shortName || l.name).join(' / ') || m.name;
            return `<label class="flex items-center gap-1.5"><input type="checkbox" ${f.menus.includes(m.code) ? 'checked' : ''}
                onchange="mpFormToggleMenu('${esc(m.code)}', this.checked)"> ${esc(br)}</label>`;
        }).join('');
        html = head('Add a new ' + esc(CFG.labels.serviceSummary.toLowerCase())) + `
            <div class="grid sm:grid-cols-2 gap-2">
                <input value="${esc(f.name)}" maxlength="80" placeholder="Name" oninput="mpFormSet('name', this.value)" class="${MP_IN}">
                <input value="${esc(f.category)}" list="mpCats" maxlength="40" placeholder="Category (pick or type a new one)" oninput="mpFormSet('category', this.value)" class="${MP_IN}">
                <datalist id="mpCats">${cats.map(c => `<option value="${esc(c)}"></option>`).join('')}</datalist>
            </div>
            <textarea maxlength="300" rows="2" placeholder="Short description for guests (optional)" oninput="mpFormSet('desc', this.value)" class="${MP_IN} w-full">${esc(f.desc)}</textarea>
            <div class="text-[11px] text-sand-800">Add to: <span class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-brand-900 mt-1">${menuBoxes}</span></div>
            <div class="space-y-1.5">${f.opts.map((o, i) => `<div class="flex items-center gap-2 text-xs">
                <input value="${esc(o.d)}" inputmode="numeric" placeholder="Minutes" oninput="mpFormSet('d', this.value, ${i})" class="w-24 ${MP_IN}"> min
                <span>${cur}</span><input value="${esc(o.p)}" inputmode="numeric" placeholder="Price" oninput="mpFormSet('p', this.value, ${i})" class="w-28 ${MP_IN}"></div>`).join('')}
                <div class="flex gap-3 text-xs"><button onclick="mpFormRow(true)" class="underline font-semibold text-brand-600">+ another duration</button>
                ${f.opts.length > 1 ? '<button onclick="mpFormRow(false)" class="underline text-sand-800">remove last</button>' : ''}</div></div>`
            + foot('mpSubmitAdd', 'Add to the menu');
    } else if (f.kind === 'dur') {
        const s = MP.model.services.find(x => x.id === f.serviceId);
        html = head('Add a duration to ' + esc(s ? s.name : '')) + `
            <div class="flex items-center gap-2 text-xs">
                <input value="${esc(f.d)}" inputmode="numeric" placeholder="Minutes" oninput="mpFormSet('d', this.value)" class="w-24 ${MP_IN}"> min
                <span>${cur}</span><input value="${esc(f.p)}" inputmode="numeric" placeholder="Price" oninput="mpFormSet('p', this.value)" class="w-28 ${MP_IN}"></div>`
            + foot('mpSubmitDur', 'Add duration');
    } else {
        html = head('Edit details') + `
            <div class="grid sm:grid-cols-2 gap-2">
                <input value="${esc(f.name)}" maxlength="80" oninput="mpFormSet('name', this.value)" class="${MP_IN}">
                <input value="${esc(f.category)}" maxlength="40" oninput="mpFormSet('category', this.value)" class="${MP_IN}"></div>
            <textarea maxlength="300" rows="2" oninput="mpFormSet('desc', this.value)" class="${MP_IN} w-full">${esc(f.desc)}</textarea>
            <label class="flex items-center gap-1.5 text-xs"><input type="checkbox" ${f.active ? 'checked' : ''} onchange="mpFormSet('active', this.checked)">
                Active (untick to hide this ${esc(CFG.labels.serviceSummary.toLowerCase())} from guests and from phone / walk-in booking)</label>`
            + foot('mpSubmitEdit', 'Save details');
    }
    box.innerHTML = html; box.classList.remove('hidden');
}

/** Shared tail of every form submit: call the database, explain a refusal, refresh the editor and the live menu. */
async function mpFormCall(btn, label, rpcName, args, done) {
    btn.disabled = true; btn.innerText = 'Saving…';
    const { data, error } = await sb.rpc(rpcName, args);
    btn.disabled = false; btn.innerText = label;
    if (error) { alert('Could not save: ' + error.message); return; }
    if (!data || data.status !== 'ok') { alert('Not saved — ' + mpWhy(data && data.status) + '.'); return; }
    MP.form = null; mpFormRender();
    await mpLoad(true, true);            // reload the tables; unsaved price edits stay on screen
    await loadLiveCatalog();             // guests and the walk-in form see it now
    alert(done(data));
}

const mpClean = s => String(s || '').replace(/\s+/g, ' ').trim();

async function mpSubmitAdd(btn) {
    const f = MP.form; if (!MP.canEdit || !f || f.kind !== 'add') return;
    const name = mpClean(f.name), category = mpClean(f.category), desc = String(f.desc || '').trim();
    if (name.length < 2 || name.length > 80) { alert('Enter a name (2 to 80 characters).'); return; }
    if (category.length < 2 || category.length > 40) { alert('Enter a category (2 to 40 characters).'); return; }
    if (desc.length > 300) { alert('The description is too long (300 characters at most).'); return; }
    if (!f.menus.length) { alert('Tick at least one menu to add it to.'); return; }
    const opts = [];
    for (const o of f.opts) {
        if (!mpIntOk(o.d, MP_DUR_MIN, MP_DUR_MAX)) { alert('Minutes must be a whole number from ' + MP_DUR_MIN + ' to ' + MP_DUR_MAX + '.'); return; }
        if (!mpPriceOk(o.p)) { alert('Enter a whole-rupee price between 1 and ' + MP_MAX_PRICE.toLocaleString(CFG.locale.numberLocale) + '.'); return; }
        opts.push({ duration: Number(o.d), price: Number(o.p) });
    }
    if (new Set(opts.map(o => o.duration)).size !== opts.length) { alert('Each duration can only be listed once.'); return; }
    const where = MP.model.menus.filter(m => f.menus.includes(m.code))
        .map(m => LOCATIONS.filter(l => l.menu === m.code).map(l => l.shortName || l.name).join('/') || m.name).join(' and ');
    if (!confirm('Add "' + name + '" (' + category + ') to ' + where + '?\n\n' +
                 opts.map(o => o.duration + ' min · ' + money(o.price)).join('\n') +
                 '\n\nGuests can book it straight away.')) return;
    await mpFormCall(btn, 'Add to the menu', 'manager_add_service',
        { p_menus: f.menus, p_category: category, p_name: name, p_description: desc, p_options: opts },
        d => '"' + name + '" was added to ' + d.count + ' menu' + (d.count === 1 ? '' : 's') + '. The booking page shows it now.');
}

async function mpSubmitDur(btn) {
    const f = MP.form; if (!MP.canEdit || !f || f.kind !== 'dur') return;
    if (!mpIntOk(f.d, MP_DUR_MIN, MP_DUR_MAX)) { alert('Minutes must be a whole number from ' + MP_DUR_MIN + ' to ' + MP_DUR_MAX + '.'); return; }
    if (!mpPriceOk(f.p)) { alert('Enter a whole-rupee price between 1 and ' + MP_MAX_PRICE.toLocaleString(CFG.locale.numberLocale) + '.'); return; }
    const s = MP.model.services.find(x => x.id === f.serviceId);
    if (!confirm('Add ' + f.d + ' min · ' + money(Number(f.p)) + ' to "' + (s ? s.name : '') + '"?')) return;
    await mpFormCall(btn, 'Add duration', 'manager_add_option',
        { p_service: f.serviceId, p_duration: Number(f.d), p_price: Number(f.p) },
        () => 'Duration added. The booking page shows it now.');
}

async function mpSubmitEdit(btn) {
    const f = MP.form; if (!MP.canEdit || !f || f.kind !== 'edit') return;
    const name = mpClean(f.name), category = mpClean(f.category), desc = String(f.desc || '').trim();
    if (name.length < 2 || name.length > 80) { alert('Enter a name (2 to 80 characters).'); return; }
    if (category.length < 2 || category.length > 40) { alert('Enter a category (2 to 40 characters).'); return; }
    if (desc.length > 300) { alert('The description is too long (300 characters at most).'); return; }
    if (!f.active && !confirm('"' + name + '" will be hidden from guests and from phone / walk-in booking. Continue?')) return;
    await mpFormCall(btn, 'Save details', 'manager_update_service',
        { p_service: f.serviceId, p_category: category, p_name: name, p_description: desc, p_active: !!f.active },
        () => 'Saved.');
}




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
    dvKpi(); dvGrid(); dvList(); thLoad(); expLoad();
}

function dvKpi() {
    const live = DV.rows.filter(b => b.status === 'confirmed');
    const addons   = live.reduce((s, b) => s + (b.addon_amt    || 0), 0);
    const discounts= live.reduce((s, b) => s + (b.discount_amt || 0), 0);
    const gross    = live.reduce((s, b) => s + (b.price || 0) + (b.addon_amt || 0), 0);
    const netRev   = gross - discounts;
    const isToday  = DV.date === ymdLocal(new Date());
    const n        = nowMins();
    const busy     = live.filter(b => b.start_min <= n && b.end_min > n).length;
    const total    = DV.branch === 'all' ? LOCATIONS.reduce((s, l) => s + capOf(l.id), 0) : capOf(DV.branch);
    const pmBreak  = ['cash','upi','card','pending'].map(pm => {
        const c = live.filter(b => b.payment_method === pm).length;
        return c ? pm.charAt(0).toUpperCase() + pm.slice(1) + ' ' + c : '';
    }).filter(Boolean).join(' · ') || 'All pending';
    const card = (a, b, c) => `<div class="bg-white border border-sand-200 rounded-xl p-3">
        <div class="text-[10px] uppercase tracking-wide text-sand-800">${a}</div>
        <div class="text-xl font-extrabold text-brand-900">${b}</div>
        <div class="text-[10px] text-sand-800">${c}</div></div>`;
    document.getElementById('dvKpi').innerHTML =
        card('Bookings', live.length, (DV.rows.length - live.length) + ' cancelled / no-show') +
        card('Net Revenue', money(netRev), addons ? 'incl. ' + money(addons) + ' add-ons' : 'expected for the day') +
        card('Discounts', discounts ? '-' + money(discounts) : '—', discounts ? 'applied today' : 'none today') +
        card('Payment Modes', pmBreak.split(' · ')[0] || '—', pmBreak) +
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
        /* a booking with no room yet is shown in its own "Unassigned" column (never guessed as Room 1) */
        const inSession = x => isToday && x.start_min <= n && x.end_min > n;
        const first = x => esc(String(x.name || '').split(' ')[0]);
        head = Array.from({ length: k }, (_, i) => {
            const busy = live.some(x => x.room_no === i + 1 && inSession(x));
            return `<th class="px-2 py-1.5 font-bold text-brand-900">Room ${i + 1}` +
                (isToday ? `<div class="text-[10px] font-semibold ${busy ? 'text-rose-700' : 'text-emerald-700'}">${busy ? 'Busy' : 'Free'}</div>` : '') + '</th>';
        }).join('') + '<th class="px-2 py-1.5 font-bold text-amber-800">Unassigned</th>';

        body = times.map(t => {
            const rowCls = isToday && n >= t && n < t + SLOT_STEP ? 'bg-amber-50' : '';
            const hit = x => x.start_min < t + SLOT_STEP && x.end_min > t;
            const starts = x => x.start_min >= t && x.start_min < t + SLOT_STEP;
            const roomCells = Array.from({ length: k }, (_, i) => {
                const b = live.find(x => x.room_no === i + 1 && hit(x));
                if (!b) return '<td class="px-2 py-1 border-t border-l border-sand-100 bg-white"></td>';
                const cls = inSession(b) ? 'bg-rose-100 text-rose-900' : 'bg-emerald-100 text-emerald-900';
                return `<td class="px-2 py-1 border-t border-l border-sand-100 ${cls}">` +
                    (starts(b) ? `<div class="font-bold leading-tight">${minsToText(b.start_min)} ${first(b)}</div>
                                  <div class="leading-tight">${esc(String(b.service_name || '').slice(0, 20))}</div>` : '') + '</td>';
            }).join('');
            const un = live.filter(x => !x.room_no && hit(x));
            const unCell = `<td class="px-2 py-1 border-t border-l border-sand-100 ${un.length ? 'bg-amber-100 text-amber-900 font-semibold' : 'bg-white'}">` +
                un.filter(starts).map(x => `<div class="leading-tight">${minsToText(x.start_min)} ${first(x)}</div>`).join('') + '</td>';
            return `<tr class="${rowCls}"><td class="px-2 py-1 text-sand-800 whitespace-nowrap border-t border-sand-100">${minsToText(t)}</td>${roomCells}${unCell}</tr>`;
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
        const pmCls = { cash: 'bg-teal-100 text-teal-800', upi: 'bg-cyan-100 text-cyan-800',
                        card: 'bg-sky-100 text-sky-800', pending: 'bg-sand-100 text-sand-800' };
        const pm = b.payment_method || 'pending';
        const netTotal = (b.price || 0) + (b.addon_amt || 0) - (b.discount_amt || 0);
        return `<div class="bg-white border border-sand-200 rounded-xl p-3 ${dead ? 'opacity-55' : ''}">
            <div class="flex flex-wrap items-center gap-2 text-xs">
                <span class="font-extrabold text-brand-900">${minsToText(b.start_min)}–${minsToText(b.end_min)}</span>
                <span class="px-2 py-0.5 rounded-full ${tag} font-semibold">${esc(b.status)}</span>
                <span class="px-2 py-0.5 rounded-full bg-sand-100 text-sand-800">${esc(b.source)}</span>
                <span class="px-2 py-0.5 rounded-full ${b.room_no ? 'bg-sand-100 text-sand-800 font-semibold' : 'bg-amber-100 text-amber-800'}">${b.room_no ? 'Room ' + b.room_no : 'no room'}</span>
                <span class="px-2 py-0.5 rounded-full ${b.therapist_name ? 'bg-indigo-100 text-indigo-800 font-semibold' : 'bg-amber-100 text-amber-800'}">${b.therapist_name ? esc(b.therapist_name) : 'no therapist'}</span>
                <span class="px-2 py-0.5 rounded-full ${pmCls[pm] || 'bg-sand-100 text-sand-800'} font-semibold">${pm.charAt(0).toUpperCase() + pm.slice(1)}</span>
                <span class="ml-auto font-mono text-sand-800">${esc(b.ref || '--')}</span>
            </div>
            <div class="mt-1 text-sm font-bold text-brand-900">${esc(b.name)} · ${esc(b.service_name)}</div>
            <div class="text-xs text-sand-800">${esc(b.loc_name)} · ${b.duration} mins · ${money(b.price)}${b.addon_amt ? ' + ' + money(b.addon_amt) + ' add-on' : ''}${b.discount_amt ? ' − ' + money(b.discount_amt) + ' disc' : ''} = <strong>${money(netTotal)}</strong>${b.notes && b.notes !== 'None' ? ' · ' + esc(b.notes) : ''}</div>
            ${b.addon_text ? `<div class="text-xs text-indigo-800 font-semibold">Add-on: ${esc(b.addon_text)}${b.addon_amt ? ' · ' + money(b.addon_amt) : ''}</div>` : ''}
            ${b.discount_text ? `<div class="text-xs text-rose-700 font-semibold">Discount: ${esc(b.discount_text)} · -${money(b.discount_amt)}</div>` : ''}
            ${b.therapist_id_2 ? `<div class="text-xs text-purple-800 font-semibold">2nd Therapist ID: ${esc(b.therapist_id_2)}</div>` : ''}
            ${b.orig_service_name ? `<div class="text-xs text-amber-800 font-semibold">Changed from: ${esc(b.orig_service_name)} on ${esc(b.orig_date || b.date)} @ ${b.orig_start_min != null ? minsToText(b.orig_start_min) : '—'} · by ${esc(b.adjusted_by || 'staff')} at ${b.adjusted_at ? esc(new Date(b.adjusted_at).toLocaleTimeString(CFG.locale.numberLocale, { hour: 'numeric', minute: '2-digit' })) : '—'}</div>` :
              (b.orig_duration ? `<div class="text-xs text-amber-800 font-semibold">Changed from ${b.orig_duration} min · ${money(b.orig_price)} · by ${esc(b.adjusted_by || 'staff')} at ${b.adjusted_at ? esc(new Date(b.adjusted_at).toLocaleTimeString(CFG.locale.numberLocale, { hour: 'numeric', minute: '2-digit' })) : '—'}</div>` : '')}
            <div class="mt-2 flex flex-wrap gap-2 no-print">
                <a href="tel:${CFG.locale.dialCode}${esc(b.phone)}" class="px-2.5 py-1 bg-brand-100 text-brand-800 rounded-lg text-[11px] font-semibold">Call</a>
                <a href="https://wa.me/${CFG.locale.countryCode}${esc(b.phone)}" target="_blank" class="px-2.5 py-1 bg-emerald-100 text-emerald-800 rounded-lg text-[11px] font-semibold">WhatsApp</a>
                ${dead ? '' : `<button onclick="dvAssign('${b.id}')" class="px-2.5 py-1 bg-indigo-100 text-indigo-800 rounded-lg text-[11px] font-semibold">${b.therapist_name ? 'Change therapist' : 'Assign therapist'}</button>`}
                ${dead ? '' : `<button onclick="dvAssign2('${b.id}')" class="px-2.5 py-1 bg-purple-100 text-purple-800 rounded-lg text-[11px] font-semibold">${b.therapist_id_2 ? 'Change 2nd therapist' : 'Assign 2nd therapist'}</button>`}
                ${dead || !FEATURES.roomAssign ? '' : dvRoomSelect(b)}
                ${dead || !FEATURES.adjustSession ? '' : `<button onclick="dvDurToggle('${b.id}', this)" class="px-2.5 py-1 bg-violet-100 text-violet-800 rounded-lg text-[11px] font-semibold">Change duration</button>`}
                ${dead ? '' : `<button onclick="dvRescheduleToggle('${b.id}', this)" class="px-2.5 py-1 bg-orange-100 text-orange-800 rounded-lg text-[11px] font-semibold">Change Therapy / Time</button>`}
                ${dead ? '' : `<button onclick="dvBillingToggle('${b.id}', this)" class="px-2.5 py-1 bg-teal-100 text-teal-800 rounded-lg text-[11px] font-semibold">Billing / Payment</button>`}
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

function staffBookingReason(code) {
    return ({
        forbidden:            'your account is not allowed to book for this branch',
        invalid:              'that branch, treatment or duration is not on the menu',
        badname:              'the guest name is too short',
        badphone:             'the phone number is not valid',
        closed:               'that time is outside the branch opening hours',
        badaddon:             'the add-on needs a description and an amount between 0 and ' + ADDON_MAX.toLocaleString(CFG.locale.numberLocale),
        baddiscount:          'discount amount exceeds the booking total, or reason is too long (80 chars max)',
        th2_wrong_branch:     '2nd therapist does not belong to this branch',
        th2_busy:             '2nd therapist is already booked at that time',
        th1_busy_as_secondary:'primary therapist is already a secondary on another booking at that time'
    })[code] || ('unexpected result: ' + code);
}
async function dvAddBooking(btn) {
    const locId = document.getElementById('aLoc').value;
    const loc   = LOCATIONS.find(l => l.id === locId);
    const [sid, durStr, priceStr] = document.getElementById('aSrv').value.split('|');
    const srv   = menuFor(locId).find(s => s.id === sid);
    const duration = Number(durStr), price = Number(priceStr);
    if (!srv) { alert('Choose a treatment first (this branch may have no active treatments).'); return; }
    const date  = document.getElementById('aDate').value;
    const start = textToMins(document.getElementById('aTime').value);
    const name  = document.getElementById('aName').value.trim();
    const phone = cleanPhone(document.getElementById('aPhone').value);
    const source= document.getElementById('aSource').value;
    const notes = document.getElementById('aNotes').value.trim() || 'None';
    const therId  = document.getElementById('aTher').value || null;
    const ther    = (TH.cands || []).find(c => c.id === therId);
    const ther2Id = document.getElementById('aTher2').value || null;
    const payMethod = document.getElementById('aPayMethod').value || 'pending';
    const addonText = FEATURES.addons ? document.getElementById('aAddon').value.trim() : '';
    const addonAmt  = FEATURES.addons ? Math.round(Number(document.getElementById('aAddonAmt').value) || 0) : 0;
    const discText  = document.getElementById('aDiscText').value.trim();
    const discAmt   = Math.round(Number(document.getElementById('aDiscAmt').value) || 0);

    if (name.length < 2) { alert('Enter the guest name.'); return; }
    if (!PHONE_RE.test(phone)) { alert(CFG.locale.phoneErrorStaff); return; }
    if (start === null) { alert('Enter a start time.'); return; }
    if (start < openOf(locId)) { alert('We open at ' + minsToText(openOf(locId)) + '. Pick a later start.'); return; }
    if (start + duration > closeOf(locId)) { alert('That session would run past ' + minsToText(closeOf(locId)) + '.'); return; }
    if (addonAmt < 0 || addonAmt > ADDON_MAX) { alert('Add-on amount must be between 0 and ' + ADDON_MAX.toLocaleString(CFG.locale.numberLocale) + '.'); return; }
    if (addonAmt > 0 && !addonText) { alert('Describe the add-on, or clear the amount.'); return; }
    if (discAmt < 0) { alert('Discount amount cannot be negative.'); return; }
    if (discText.length > 80) { alert('Discount reason must be 80 characters or less.'); return; }

    btn.disabled = true; btn.innerText = 'Saving…';
    let ref = CFG.brand.refPrefix + Math.floor(100000 + Math.random() * 900000);
    let newId = null, hardError = null, full = false;

    /* Staff bookings start WITHOUT a room: pick one afterwards with the room selector. The database refuses
       to overbook the branch. v2: the database picks the reference and takes the price from the menu. */
    if (V2) {
        const { data, error } = await sb.rpc('staff_create_booking', {
            p_branch: locId, p_service: srv.id, p_duration: duration, p_date: date, p_start: start,
            p_name: name, p_phone: phone, p_notes: notes, p_source: source,
            p_addon_text: addonText || null, p_addon_amt: addonAmt,
            p_payment_method: payMethod,
            p_discount_text: discText || null, p_discount_amt: discAmt,
            p_therapist_id_2: ther2Id || null
        });
        if (error) hardError = error.message;
        else if (data.status === 'ok') { newId = data.id; ref = data.ref; }
        else if (data.status === 'full') full = true;
        else hardError = staffBookingReason(data.status);
    } else {
        const who = (await sb.auth.getUser()).data.user?.email || 'staff';
        const ins = await sb.from('bookings').insert({
            kind: 'booking', status: 'confirmed', ref: ref,
            loc_id: locId, loc_name: loc.name,
            service_id: srv.id, service_name: srv.name + ' (' + duration + ' Mins)',
            duration: duration, price: price,
            date: date, start_min: start, end_min: start + duration,
            name: name, phone: phone, notes: notes, source: source,
            addon_text: addonText || null, addon_amt: addonAmt,
            created_by: who
        }).select('id').single();
        if (ins.error) { if (String(ins.error.message).includes('CENTRE_FULL')) full = true; else hardError = ins.error.message; }
        else newId = ins.data.id;
    }

    btn.disabled = false; btn.innerText = 'Save booking';
    if (hardError) { alert('Could not save: ' + hardError); return; }
    if (full || !newId) { alert('The ' + CFG.labels.branchWord + ' is fully booked at that time. Pick another slot.'); return; }

    let msg = 'Booked. Ref ' + ref;
    if (therId) {
        const { data, error } = await sb.rpc('assign_therapist', { p_booking_id: newId, p_therapist_id: therId });
        if (error)          msg += '\n\n⚠️ Saved, but therapist not assigned: ' + error.message;
        else if (data === 'ok') msg += '\nTherapist: ' + (ther ? ther.name : '');
        else                msg += '\n\n⚠️ Saved WITHOUT a therapist — ' + thReason(data) + '\nAssign someone else from the list below.';
    }
    alert(msg);

    document.getElementById('aName').value     = '';
    document.getElementById('aPhone').value    = '';
    document.getElementById('aNotes').value    = '';
    document.getElementById('aAddon').value    = '';
    document.getElementById('aAddonAmt').value = '';
    document.getElementById('aDiscText').value = '';
    document.getElementById('aDiscAmt').value  = '';
    document.getElementById('aPayMethod').value= 'pending';
    document.getElementById('dvDate').value    = date;
    dvLoad();
}

function dvCsv() {
    const cols = ['ref','date','start','end','loc_name','service_name','duration','price',
                  'addon_text','addon_amt','discount_text','discount_amt','payment_method','net_total',
                  'room_no','therapist_name','therapist_2','name','phone','status','source','created_by','notes'];
    const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const body = DV.rows.map(r => cols.map(c =>
        q(c === 'start'      ? minsToText(r.start_min)
        : c === 'end'        ? minsToText(r.end_min)
        : c === 'net_total'  ? (r.price || 0) + (r.addon_amt || 0) - (r.discount_amt || 0)
        : c === 'therapist_2'? (r.therapist_id_2 || '')
        : r[c])).join(',')).join('\n');
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
        not_registered: 'she is not on the roster for that ' + CFG.labels.branchWord + ' and date',
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
        box.innerHTML = '<div class="p-4 text-center text-sand-800">Pick a single ' + CFG.labels.branchWord + ' above to see and manage its therapist roster.</div>';
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

/* ---- 2nd therapist dropdown for the walk-in form ---- */
let aTher2Timer = null;
const aTher2Refresh = () => { clearTimeout(aTher2Timer); aTher2Timer = setTimeout(aFillTherapists2, 350); };

async function aFillTherapists2() {
    const sel  = document.getElementById('aTher2');
    const note = document.getElementById('aTher2Note');
    if (!sel) return;
    const locId = document.getElementById('aLoc').value;
    const date  = document.getElementById('aDate').value;
    const start = textToMins(document.getElementById('aTime').value);
    const dur   = Number((document.getElementById('aSrv').value || '').split('|')[1]) || 60;
    const th1   = document.getElementById('aTher').value;

    if (!locId || !date || start === null) {
        sel.innerHTML = '<option value="">— No 2nd therapist —</option>';
        note.innerHTML = '&nbsp;'; return;
    }
    sel.innerHTML = '<option value="">Checking…</option>';
    const cands = await thCandidates(locId, date, start, dur);
    // exclude whoever is already picked as therapist 1
    const eligible = cands.filter(c => c.id !== th1);
    const free = eligible.filter(c => c.ok);

    sel.innerHTML = '<option value="">— No 2nd therapist —</option>' +
        eligible.map(c => `<option value="${c.id}"${c.ok ? '' : ' disabled'}>${esc(c.name)} · ${minsToText(c.arrival)}${c.ok ? '' : ' — ' + esc(c.why)}</option>`).join('');

    if (free.length) {
        note.innerText = free.length + ' therapist(s) available as 2nd.';
        note.className = 'text-[11px] text-emerald-700 mt-1';
    } else {
        note.innerText = eligible.length ? 'No 2nd therapist free for this slot.' : 'No other therapists on roster.';
        note.className = 'text-[11px] text-sand-800 mt-1';
    }
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
            : 'No therapists on the roster for this ' + CFG.labels.branchWord + ' and date.';
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

    const { data, error } = await sb.rpc('assign_therapist', { p_booking_id: id, p_therapist_id: t ? t.id : null, p_slot: 'primary' });
    if (error) { alert('Could not assign: ' + error.message); return; }
    if (data !== 'ok') { alert('Not assigned — ' + thReason(data) + '.'); return; }
    dvLoad();
}

/* ---- assign or change the 2nd therapist on an existing booking ---- */
async function dvAssign2(id) {
    const b = DV.rows.find(r => r.id === id); if (!b) return;
    const cands = await thCandidates(b.loc_id, b.date, b.start_min, b.duration);
    // exclude primary therapist
    const eligible = cands.filter(c => c.id !== b.therapist_id);
    if (!eligible.length) { alert('No other therapists are on the roster for ' + b.loc_name + ' on ' + b.date + '.'); return; }

    const list = eligible.map((c, i) => (i + 1) + '. ' + c.name + ' (' + minsToText(c.arrival) + ') — ' + (c.ok ? 'FREE' : c.why)).join('\n');
    const pick = prompt('Assign a 2nd therapist to ' + b.name + ', ' + minsToText(b.start_min) + '–' + minsToText(b.end_min) +
                        '\n\n' + list + '\n\nType the number, or 0 to remove 2nd therapist:');
    if (pick === null) return;
    const idx = Number(pick);
    if (!Number.isInteger(idx) || idx < 0 || idx > eligible.length) { alert('That is not a valid number.'); return; }
    const t = idx === 0 ? null : eligible[idx - 1];

    const { data, error } = await sb.rpc('assign_therapist', { p_booking_id: id, p_therapist_id: t ? t.id : null, p_slot: 'secondary' });
    if (error) { alert('Could not assign: ' + error.message); return; }
    if (data !== 'ok') { alert('Not assigned — ' + thReason(data) + '.'); return; }
    dvLoad();
}

/* ============================================================
   14. ROOMS + CHANGE DURATION  (staff console; switched on per client with features.roomAssign / adjustSession)
   ============================================================ */
/** Room picker for one booking. Rooms already in use by another confirmed booking in that time are greyed out. */
function dvRoomSelect(b) {
    const k = capOf(b.loc_id);
    const opts = Array.from({ length: k }, (_, i) => {
        const r = i + 1;
        const clash = DV.rows.find(x => x.id !== b.id && x.loc_id === b.loc_id && x.status === 'confirmed'
            && x.room_no === r && x.start_min < b.end_min && x.end_min > b.start_min);
        return `<option value="${r}"${b.room_no === r ? ' selected' : ''}${clash ? ' disabled' : ''}>Room ${r}${clash ? ' (busy ' + minsToText(clash.start_min) + '–' + minsToText(clash.end_min) + ')' : ''}</option>`;
    }).join('');
    return `<select onchange="dvAssignRoom('${b.id}', this.value)" class="px-2 py-1 border border-sand-200 rounded-lg text-[11px] font-semibold ${b.room_no ? 'bg-sand-100' : 'bg-amber-100'}">
        <option value=""${b.room_no ? '' : ' selected'}>${b.room_no ? 'Unassign room' : 'Assign room…'}</option>${opts}</select>`;
}

async function dvAssignRoom(id, val) {
    const room = val === '' ? null : Number(val);
    const { data, error } = await sb.rpc('assign_room', { p_booking_id: id, p_room: room });
    if (error) alert('Could not assign: ' + error.message);
    else if (data === 'busy') alert('That room is already in use during this session.');
    else if (data !== 'ok') alert('Not assigned: ' + data);
    dvLoad();
}

/** Only an owner / manager may type their own minutes or amount. Front desk picks standard menu options.
 *  (The database enforces the same rule, so hiding the fields is a convenience, not the protection.) */
const dvCanCustom = () => !V2 || MP.canEdit;

function dvDurToggle(id, btn) {
    const b = DV.rows.find(r => r.id === id); if (!b) return;
    const row  = btn.parentElement;
    const card = row.parentElement;
    const open = card.querySelector(':scope > .dur-panel');
    if (open) { const same = open.dataset.id === id; open.remove(); if (same) return; }

    const srv = menuFor(b.loc_id).find(s => s.id === b.service_id);
    const chips = (srv ? srv.options : []).map(o =>
        `<button type="button" onclick="dvDurPick('${id}', ${o.duration}, ${o.price})" class="px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-white border border-violet-300 text-violet-800">${o.duration} min · ${money(o.price)}</button>`
    ).join('');
    const custom = dvCanCustom();
    row.insertAdjacentHTML('afterend',
        `<div class="dur-panel mt-2 p-2.5 bg-sand-50 border border-sand-200 rounded-lg space-y-2" data-id="${id}">
            <div class="text-[11px] text-sand-800">Now: <strong>${b.duration} min · ${money(b.price)}</strong>. ${custom ? 'Tap a menu option, or type your own minutes and amount.' : 'Tap a menu option below. Only an owner or manager can type a custom time or amount.'}</div>
            <div class="flex flex-wrap gap-1.5">${chips || '<span class="text-[11px] text-sand-800">This treatment is not on the current menu.</span>'}</div>
            <div class="flex flex-wrap items-center gap-2 text-xs">
                <input id="dd-${id}" type="number" min="${DUR_MIN}" max="${DUR_MAX}" step="5" value="${b.duration}" ${custom ? '' : 'readonly'} class="w-20 p-2 border border-sand-200 rounded-lg ${custom ? '' : 'bg-sand-100'}"> min
                <input id="dp-${id}" type="number" min="0" max="100000" step="1" value="${b.price}" ${custom ? '' : 'readonly'} class="w-28 p-2 border border-sand-200 rounded-lg ${custom ? '' : 'bg-sand-100'}"> ${esc(CFG.locale.currencySymbol)}
                <button onclick="dvDurSave('${id}')" class="px-3 py-1.5 bg-violet-700 text-white rounded-lg font-bold">Save change</button>
            </div>
        </div>`);
}

function dvDurPick(id, dur, price) {
    document.getElementById('dd-' + id).value = dur;
    document.getElementById('dp-' + id).value = price;
}


async function dvDurSave(id) {
    const b = DV.rows.find(r => r.id === id); if (!b) return;
    const dur   = Math.round(Number(document.getElementById('dd-' + id).value));
    const price = Math.round(Number(document.getElementById('dp-' + id).value));
    if (!dur || dur < DUR_MIN || dur > DUR_MAX) { alert('Enter a duration between ' + DUR_MIN + ' and ' + DUR_MAX + ' minutes.'); return; }
    if (isNaN(price) || price < 0)              { alert('Enter a valid amount.'); return; }

    if (!confirm('CHANGE SESSION — ' + b.name + '\n\n' +
                 'From: ' + b.duration + ' min · ' + money(b.price) + '  (ends ' + minsToText(b.end_min) + ')\n' +
                 'To:   ' + dur + ' min · ' + money(price) + '  (ends ' + minsToText(b.start_min + dur) + ')\n\n' +
                 'Revenue changes by ' + money(price - b.price) + '. OK to save?')) return;

    const { data, error } = await sb.rpc('adjust_session', { p_booking_id: id, p_duration: dur, p_price: price });
    if (error) { alert('Could not save: ' + error.message); return; }

    const msg = {
        ok: null,
        no_change: 'Nothing changed.',
        past_close: 'That would run past closing time (' + minsToText(closeOf(b.loc_id)) + ').',
        therapist_busy: 'The therapist has another booking in that extra time. Use Change therapist first, then extend.',
        room_busy: 'This room is booked by another guest in that extra time. Pick another room with the room selector first, then extend.',
        centre_full: 'The ' + CFG.labels.branchWord + ' is fully booked during the extra time.',
        busy: 'The therapist or room is busy in that extra time.',
        not_confirmed: 'Only confirmed bookings can be changed.',
        not_allowed: 'Only an owner or manager can set a custom time or amount. Pick a menu option instead.',
        bad_input: 'Check the minutes and amount.',
        no_booking: 'That booking no longer exists, or is not yours to change.'
    }[data];
    if (msg) alert(msg);
    else if (data !== 'ok') alert('Unexpected result: ' + data);
    dvLoad();
}

/* ============================================================
   15. CHANGE THERAPY / TIME (reschedule_booking)
   ============================================================ */
function dvRescheduleToggle(id, btn) {
    const b = DV.rows.find(r => r.id === id); if (!b) return;
    const row  = btn.parentElement;
    const card = row.parentElement;
    const open = card.querySelector(':scope > .reschedule-panel');
    if (open) { const same = open.dataset.id === id; open.remove(); if (same) return; }

    const srv = menuFor(b.loc_id);
    const opts = srv.flatMap(s => s.options.map(o =>
        `<option value="${s.id}|${o.duration}|${o.price}"${b.service_id === s.id && b.duration === o.duration ? ' selected' : ''}>${esc(s.name)} — ${o.duration}m — ${money(o.price)}</option>`
    )).join('');

    row.insertAdjacentHTML('afterend',
        `<div class="reschedule-panel mt-2 p-2.5 bg-orange-50 border border-orange-200 rounded-lg space-y-2" data-id="${id}">
            <div class="text-[11px] text-sand-800 font-semibold">Change Therapy / Time — ${esc(b.name)}</div>
            <div class="text-[11px] text-sand-800">Now: <strong>${esc(b.service_name)}</strong> on ${b.date} @ ${minsToText(b.start_min)}</div>
            <div class="grid sm:grid-cols-3 gap-2 text-xs">
                <select id="rs-srv-${id}" class="p-2 border border-sand-200 rounded-lg sm:col-span-3">${opts}</select>
                <input id="rs-date-${id}" type="date" value="${b.date}" class="p-2 border border-sand-200 rounded-lg">
                <input id="rs-time-${id}" type="time" step="300" value="${pad2(Math.floor(b.start_min/60))}:${pad2(b.start_min%60)}" class="p-2 border border-sand-200 rounded-lg">
                <button onclick="dvRescheduleSave('${id}', this)" class="py-2 bg-orange-600 text-white rounded-lg font-bold">Save Change</button>
            </div>
        </div>`);
}

async function dvRescheduleSave(id, btn) {
    const b = DV.rows.find(r => r.id === id); if (!b) return;
    const srvVal = document.getElementById('rs-srv-' + id).value;
    const [sid, durStr] = srvVal.split('|');
    const dur = Number(durStr);
    const dateVal = document.getElementById('rs-date-' + id).value;
    const start  = textToMins(document.getElementById('rs-time-' + id).value);
    if (start === null) { alert('Enter a valid start time.'); return; }

    btn.disabled = true; btn.innerText = 'Saving…';
    let soId = null;
    if (V2 && sid && dur) {
        const { data: soData } = await sb.from('service_options')
            .select('id').eq('service_id', sid).eq('duration_min', dur).eq('active', true).limit(1);
        if (soData && soData.length) soId = soData[0].id;
    }

    const sameService = b.service_id === sid && b.duration === dur;
    if (sameService && b.date === dateVal && b.start_min === start) {
        btn.disabled = false; btn.innerText = 'Save Change';
        alert('Nothing changed.'); return;
    }

    const { data, error } = await sb.rpc('reschedule_booking', {
        p_booking_id: id,
        p_service_option_id: soId || null,
        p_date: dateVal,
        p_start_min: start
    });
    btn.disabled = false; btn.innerText = 'Save Change';
    if (error) { alert('Could not save: ' + error.message); return; }
    const rsMsg = { no_change: 'Nothing changed.', not_confirmed: 'Only confirmed bookings can be rescheduled.',
        invalid: 'That treatment is not on this branch\'s menu.', closed: 'That time is outside the branch opening hours.',
        therapist_busy: 'The primary therapist has another booking at that time.',
        th2_busy: 'The 2nd therapist has another booking at that time.',
        room_busy: 'The room is busy at the new time.',
        centre_full: 'The ' + CFG.labels.branchWord + ' is fully booked at the new time.',
        no_booking: 'Booking not found or not yours to change.' }[data];
    if (rsMsg) alert(rsMsg);
    else if (data !== 'ok') alert('Unexpected result: ' + data);
    dvLoad();
}

/* ============================================================
   16. BILLING / PAYMENT EDITOR (update_booking_billing)
   ============================================================ */
function dvBillingToggle(id, btn) {
    const b = DV.rows.find(r => r.id === id); if (!b) return;
    const row  = btn.parentElement;
    const card = row.parentElement;
    const open = card.querySelector(':scope > .billing-panel');
    if (open) { const same = open.dataset.id === id; open.remove(); if (same) return; }

    const pmOpts = ['pending','cash','upi','card'].map(pm =>
        `<option value="${pm}"${(b.payment_method || 'pending') === pm ? ' selected' : ''}>${pm.charAt(0).toUpperCase() + pm.slice(1)}</option>`
    ).join('');

    row.insertAdjacentHTML('afterend',
        `<div class="billing-panel mt-2 p-2.5 bg-teal-50 border border-teal-200 rounded-lg space-y-2" data-id="${id}">
            <div class="text-[11px] text-sand-800 font-semibold">Billing / Payment — ${esc(b.name)}</div>
            <div class="grid sm:grid-cols-2 gap-2 text-xs">
                <select id="bl-pm-${id}" class="p-2 border border-sand-200 rounded-lg">${pmOpts}</select>
                <div></div>
                <input id="bl-addon-${id}" maxlength="80" value="${esc(b.addon_text || '')}" placeholder="Add-on description" class="p-2 border border-sand-200 rounded-lg">
                <input id="bl-addonamt-${id}" type="number" min="0" max="100000" step="1" inputmode="numeric" value="${b.addon_amt || 0}" placeholder="Add-on ${esc(CFG.locale.currencySymbol)}" class="p-2 border border-sand-200 rounded-lg">
                <input id="bl-disc-${id}" maxlength="80" value="${esc(b.discount_text || '')}" placeholder="Discount reason" class="p-2 border border-sand-200 rounded-lg">
                <input id="bl-discamt-${id}" type="number" min="0" max="100000" step="1" inputmode="numeric" value="${b.discount_amt || 0}" placeholder="Discount ${esc(CFG.locale.currencySymbol)}" class="p-2 border border-sand-200 rounded-lg">
            </div>
            <button onclick="dvBillingSave('${id}', this)" class="w-full py-2 bg-teal-700 text-white rounded-lg font-bold text-xs">Save Billing</button>
        </div>`);
}

async function dvBillingSave(id, btn) {
    const b = DV.rows.find(r => r.id === id); if (!b) return;
    const pm       = document.getElementById('bl-pm-' + id).value;
    const addonTxt = document.getElementById('bl-addon-' + id).value.trim();
    const addonAmt = Math.round(Number(document.getElementById('bl-addonamt-' + id).value) || 0);
    const discTxt  = document.getElementById('bl-disc-' + id).value.trim();
    const discAmt  = Math.round(Number(document.getElementById('bl-discamt-' + id).value) || 0);

    if (addonAmt > 0 && !addonTxt) { alert('Describe the add-on, or set amount to 0.'); return; }
    if (addonTxt.length > 80)      { alert('Add-on description max 80 characters.'); return; }
    if (discTxt.length > 80)       { alert('Discount reason max 80 characters.'); return; }
    if (discAmt < 0)               { alert('Discount amount cannot be negative.'); return; }

    btn.disabled = true; btn.innerText = 'Saving…';
    const { data, error } = await sb.rpc('update_booking_billing', {
        p_booking_id:     id,
        p_payment_method: pm,
        p_addon_text:     addonTxt || null,
        p_addon_amt:      addonAmt,
        p_discount_text:  discTxt || null,
        p_discount_amt:   discAmt
    });
    btn.disabled = false; btn.innerText = 'Save Billing';
    if (error) { alert('Could not save: ' + error.message); return; }
    const blMsg = { not_confirmed: 'Only confirmed bookings can be edited.',
        badaddon: 'Add-on needs a description and a valid amount.',
        baddiscount: 'Discount exceeds the booking total, or reason is too long.',
        invalid: 'Invalid payment method.',
        no_booking: 'Booking not found or not yours to change.' }[data];
    if (blMsg) alert(blMsg);
    else if (data !== 'ok') alert('Unexpected result: ' + data);
    dvLoad();
}

/* ============================================================
   17. EXPENSES  (expenses table)
   ============================================================ */
let EXP = { rows: [], canEdit: false };

function expApplyRole(role) { EXP.canEdit = role === 'owner' || role === 'manager'; }
function expToggleAdd() { document.getElementById('expAddForm').classList.toggle('hidden'); }

async function expLoad() {
    const branchId = document.getElementById('dvBranch').value;
    const date     = document.getElementById('dvDate').value || ymdLocal(new Date());
    const listEl   = document.getElementById('expList');
    const sumEl    = document.getElementById('expSummary');
    if (!listEl || !sumEl) return;
    if (branchId === 'all') {
        listEl.innerHTML = '<div class="text-sand-800 py-2">Select a single branch to view expenses.</div>';
        sumEl.innerHTML = ''; EXP.rows = []; return;
    }
    const { data, error } = await sb.from('expenses').select('*')
        .eq('branch_id', branchId).eq('expense_date', date).order('created_at', { ascending: true });
    if (error) { listEl.innerHTML = '<div class="text-rose-700">Could not load expenses: ' + esc(error.message) + '</div>'; return; }
    EXP.rows = data || [];
    expRender();
}

function expRender() {
    const listEl = document.getElementById('expList');
    const sumEl  = document.getElementById('expSummary');
    if (!listEl || !sumEl) return;
    if (!EXP.rows.length) { listEl.innerHTML = '<div class="text-sand-800 py-1">No expenses logged for this date.</div>'; sumEl.innerHTML = ''; return; }
    const pmCls = { cash: 'bg-teal-100 text-teal-800', upi: 'bg-cyan-100 text-cyan-800', card: 'bg-sky-100 text-sky-800' };
    listEl.innerHTML = EXP.rows.map(e => {
        const pc = pmCls[e.payment_mode] || 'bg-sand-100 text-sand-800';
        return `<div class="flex items-start justify-between gap-2 py-1.5 border-b border-sand-100 last:border-0">
            <div class="flex-1 min-w-0"><span class="font-semibold text-brand-900 break-words">${esc(e.description)}</span>
                <span class="ml-2 px-1.5 py-0.5 rounded text-[10px] font-semibold ${pc}">${e.payment_mode}</span></div>
            <div class="font-bold text-brand-900 whitespace-nowrap">${money(e.amount)}</div>
            ${EXP.canEdit ? `<button onclick="expEdit('${e.id}')" class="px-2 py-0.5 bg-sand-100 text-sand-800 rounded text-[10px] font-semibold no-print">Edit</button>
            <button onclick="expDelete('${e.id}')" class="px-2 py-0.5 bg-rose-100 text-rose-800 rounded text-[10px] font-semibold no-print">Del</button>` : ''}</div>`;
    }).join('');
    const totalExp = EXP.rows.reduce((s, e) => s + e.amount, 0);
    const cashExp  = EXP.rows.filter(e => e.payment_mode === 'cash').reduce((s, e) => s + e.amount, 0);
    const live     = DV.rows.filter(b => b.status === 'confirmed');
    const cashRev  = live.filter(b => b.payment_method === 'cash').reduce((s, b) => s + (b.price || 0) + (b.addon_amt || 0) - (b.discount_amt || 0), 0);
    const netCash  = cashRev - cashExp;
    sumEl.innerHTML = `<div class="flex flex-wrap gap-4 text-xs mt-1">
        <span>Total Expenses: <strong class="text-rose-700">${money(totalExp)}</strong></span>
        <span>Cash Expenses: <strong class="text-rose-700">${money(cashExp)}</strong></span>
        <span>Cash Revenue: <strong class="text-emerald-700">${money(cashRev)}</strong></span>
        <span class="font-bold">Net Cash in Hand: <strong class="${netCash >= 0 ? 'text-emerald-700' : 'text-rose-700'}">${money(netCash)}</strong></span>
        </div>`;
}

async function expSave(btn) {
    const branchId = document.getElementById('dvBranch').value;
    const date     = document.getElementById('dvDate').value || ymdLocal(new Date());
    const desc     = document.getElementById('expDesc').value.trim();
    const amt      = Math.round(Number(document.getElementById('expAmt').value) || 0);
    const mode     = document.getElementById('expMode').value;
    if (branchId === 'all') { alert('Select a specific branch before logging an expense.'); return; }
    if (!desc)             { alert('Enter a description.'); return; }
    if (desc.length > 160) { alert('Description must be 160 characters or less.'); return; }
    if (amt < 1)           { alert('Enter a valid amount (' + CFG.locale.currencySymbol + '1 or more).'); return; }
    btn.disabled = true; btn.innerText = 'Saving…';
    const { error } = await sb.from('expenses').insert({ branch_id: branchId, expense_date: date, description: desc, amount: amt, payment_mode: mode });
    btn.disabled = false; btn.innerText = 'Save Expense';
    if (error) { alert('Could not save: ' + error.message); return; }
    document.getElementById('expDesc').value = '';
    document.getElementById('expAmt').value  = '';
    document.getElementById('expAddForm').classList.add('hidden');
    expLoad();
}

async function expEdit(id) {
    if (!EXP.canEdit) return;
    const e = EXP.rows.find(r => r.id === id); if (!e) return;
    const desc = prompt('Edit description:', e.description);
    if (desc === null) return;
    if (!desc.trim() || desc.trim().length > 160) { alert('Description must be 1–160 characters.'); return; }
    const amtStr = prompt('Edit amount (' + CFG.locale.currencySymbol + '):', String(e.amount));
    if (amtStr === null) return;
    const amt = Math.round(Number(amtStr));
    if (isNaN(amt) || amt < 1) { alert('Enter a valid amount.'); return; }
    const { error } = await sb.from('expenses').update({ description: desc.trim(), amount: amt }).eq('id', id);
    if (error) { alert('Could not update: ' + error.message); return; }
    expLoad();
}

async function expDelete(id) {
    if (!EXP.canEdit) return;
    const e = EXP.rows.find(r => r.id === id); if (!e) return;
    if (!confirm('Delete expense: ' + e.description + '?')) return;
    const { error } = await sb.from('expenses').delete().eq('id', id);
    if (error) { alert('Could not delete: ' + error.message); return; }
    expLoad();
}



