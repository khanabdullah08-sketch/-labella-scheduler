import { boot, buildWithFakeSupabase } from './fakeenv.mjs';

/** Shared set-up for the Menu & Prices "add a treatment" page tests: LaBella, a small in-memory menu, a logged-in staff member. */
export const copy = x => JSON.parse(JSON.stringify(x));

export function makeStore() {
  const menus = [{ id: 'm-def', code: 'def', name: 'Defence Colony Menu' }, { id: 'm-cp', code: 'cp', name: 'Connaught Place Menu' }];
  const services = [
    { id: 'sv-df06', menu_id: 'm-def', code: 'df06', category: 'Massage', name: 'Balinese Massage', description: 'Classic.', sort: 6, active: true },
    { id: 'sv-cp03', menu_id: 'm-cp', code: 'cp03', category: 'Ritual', name: 'Balinese Massage', description: 'Classic.', sort: 3, active: true }
  ];
  const options = [
    { id: 'o-df06-60', service_id: 'sv-df06', duration_min: 60, price: 2799, active: true, sort: 0 },
    { id: 'o-cp03-60', service_id: 'sv-cp03', duration_min: 60, price: 3799, active: true, sort: 0 }
  ];
  const catalog = () => ({ menus: Object.fromEntries(menus.map(m => [m.code, services.filter(s => s.menu_id === m.id && s.active).map(s => ({
    id: s.code, cat: s.category, name: s.name, desc: s.description,
    options: options.filter(o => o.service_id === s.id && o.active).map(o => ({ duration: o.duration_min, price: o.price })) }))])) });
  return { menus, services, options, catalog };
}

/** Boot the page as `opts.role` (default owner), open Menu & Prices. `replies[rpcName](args, store)` answers database calls. */
export async function openPrices(replies = {}, opts = {}) {
  const { outDir, appConfig } = buildWithFakeSupabase('labella');
  const store = makeStore();
  const tables = { menus: store.menus, services: store.services, service_options: store.options };
  const env = boot(outDir, appConfig, (name, args) => {
    if (name === 'get_catalog') return { data: store.catalog(), error: null };
    if (replies[name]) return replies[name](args, store);
    return { data: [], error: null };
  }, {
    session: { user: { id: 'u1' } }, ...opts,
    from: op => op.table === 'staff' ? { data: [{ role: opts.role || 'owner' }], error: null }
      : op.action === 'select' && tables[op.table] ? { data: copy(tables[op.table]), error: null } : { data: [], error: null }
  });
  await env.t.dvGate(); await env.t.dvTab('prices');
  return { ...env, store };
}

export const sent = (env, name) => env.rpcCalls.filter(c => c[0] === name);
export const fillAdd = (t, name = 'Okay Name', cat = 'Massage', d = '60', p = '100') => {
  t.mpFormSet('name', name); t.mpFormSet('category', cat); t.mpFormSet('d', d, 0); t.mpFormSet('p', p, 0);
};
export const btn = () => ({ disabled: false, innerText: '' });
