/**
 * Settings unit tests:  npx tsx src/settings/settings.test.ts
 */
import assert from '../rooms/assert.test-util.js';
import { CvarRegistry, DEFS, PRESETS } from './cvars.js';
import { Binds, DEFAULT_BINDS, keyName, mouseKeyName } from './binds.js';
import { Configs } from './configs.js';
import { Settings, LOCAL_KEY, VAULT_KEY, tokenize, splitStatements, type KV, type VaultDocLike } from './persist.js';
import { paletteCss, rowRamp, PALETTE_ROWS } from './palette.js';

let n = 0;
const test = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); n++; } catch (err) { console.error(`FAIL ${name}`); throw err; }
};
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

class MemKV implements KV {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
}

class FakeVault implements VaultDocLike {
  doc: Record<string, unknown> = {};
  saves = 0;
  fail = false;
  async load() { return structuredClone(this.doc); }
  get(k: string) { return this.doc[k]; }
  set(k: string, v: unknown) { this.doc[k] = structuredClone(v); }
  async save() { if (this.fail) throw new Error('quorum'); this.saves++; return { version: this.saves }; }
  onConflict() { /* not exercised */ }
}

const fresh = () => {
  const cv = new CvarRegistry(DEFS);
  const bi = new Binds();
  const co = new Configs();
  const kv = new MemKV();
  const s = new Settings({ storage: kv, cvars: cv, binds: bi, configs: co, localDebounceMs: 1, vaultDebounceMs: 1, onError: () => undefined });
  return { cv, bi, co, kv, s };
};

await test('QW defaults and names', () => {
  const cv = new CvarRegistry(DEFS);
  assert.equal(cv.get('sensitivity'), '3');
  assert.equal(cv.get('m_pitch'), '0.022');
  assert.equal(cv.get('fov'), '90');
  assert.equal(cv.get('crosshaircolor'), '79');
  assert.equal(cv.get('cl_bob'), '0.02');
  assert.equal(cv.get('cl_rollangle'), '2');
  assert.equal(cv.num('viewsize'), 100);
  assert.equal(cv.get('nonexistent'), '');
  assert.equal(new Set(DEFS.map((d) => d.name)).size, DEFS.length);
});

await test('set parses, clamps, rounds, refuses junk; listeners fire once per real change', () => {
  const cv = new CvarRegistry(DEFS);
  const seen: string[] = [];
  cv.onChange('fov', (k, v, old) => seen.push(`${k}:${old}->${v}`));
  const all: string[] = [];
  cv.onChange('*', (k) => all.push(k));
  assert.ok(cv.set('fov', 400)); assert.equal(cv.get('fov'), '170');
  assert.ok(cv.set('FOV', '110')); assert.equal(cv.get('fov'), '110');
  assert.ok(cv.set('fov', '110'));
  assert.ok(!cv.set('fov', 'wide'));
  assert.deepEqual(seen, ['fov:90->170', 'fov:170->110']);
  assert.ok(cv.set('crosshair', 3.6)); assert.equal(cv.get('crosshair'), '4');
  assert.ok(cv.set('r_bloom', 'off')); assert.equal(cv.get('r_bloom'), '0'); assert.equal(cv.bool('r_bloom'), false);
  assert.ok(cv.set('hud_layout', 'MODERN')); assert.equal(cv.get('hud_layout'), 'modern');
  assert.ok(!cv.set('hud_layout', 'fancy'));
  assert.ok(cv.set('name', '  bad\\"name\u0001 that is far too long to keep  ')); assert.equal(cv.get('name'), 'badname that is far ');
  assert.ok(cv.set('topcolor', 99)); assert.equal(cv.get('topcolor'), '13');
  assert.ok(!cv.set('nope', 1));
  assert.ok(all.includes('crosshair'));
});

await test('presets', () => {
  const cv = new CvarRegistry(DEFS);
  assert.equal(cv.currentPreset(), 'modern');
  cv.applyPreset('classic');
  assert.equal(cv.get('gl_flashblend'), '1');
  assert.equal(cv.get('r_bloom'), '0');
  assert.equal(cv.currentPreset(), 'classic');
  cv.set('r_bloom', 1);
  assert.equal(cv.currentPreset(), 'custom');
  for (const p of Object.values(PRESETS)) for (const k of Object.keys(p)) assert.ok(cv.def(k)?.preset, k);
});

await test('runtime-registered cvars pick up saved values', () => {
  const cv = new CvarRegistry(DEFS);
  cv.load({ cl_maxfps: '144', fov: '120' });
  assert.equal(cv.get('fov'), '120');
  assert.equal(cv.snapshot().cl_maxfps, '144');
  cv.register({ name: 'cl_maxfps', def: '0', kind: 'int', min: 0, max: 1000, group: 'video', label: 'Max FPS', help: '' });
  assert.equal(cv.get('cl_maxfps'), '144');
});

await test('binds', () => {
  const b = new Binds();
  assert.equal(b.get('W'), '+forward');
  b.set('mouse4', '+jump');
  assert.deepEqual(b.keysFor('+jump').sort(), ['mouse2', 'mouse4', 'space']);
  b.set('w', '');
  assert.equal(b.get('w'), '');
  b.unbindAll();
  assert.equal(b.all().length, 0);
  b.resetDefaults();
  assert.equal(b.all().length, Object.keys(DEFAULT_BINDS).length);
  assert.equal(keyName({ code: 'KeyW', key: 'z' }), 'w');
  assert.equal(keyName({ code: 'Space', key: ' ' }), 'space');
  assert.equal(keyName({ code: 'Digit3', key: '#' }), '3');
  assert.equal(keyName({ code: 'F12', key: 'F12' }), 'f12');
  assert.equal(keyName({ code: 'Backquote', key: '`' }), '`');
  assert.equal(mouseKeyName(0), 'mouse1');
  assert.equal(mouseKeyName(2), 'mouse2');
  assert.equal(mouseKeyName(1), 'mouse3');
});

await test('configs', () => {
  const c = new Configs();
  c.save('Autoexec', 'fov 110');
  assert.deepEqual(c.list(), ['autoexec.cfg']);
  assert.equal(c.get('autoexec.cfg'), 'fov 110');
  assert.throws(() => c.save('../x', ''));
  assert.throws(() => c.save('big', 'x'.repeat(70_000)));
  c.remove('autoexec');
  assert.equal(c.list().length, 0);
});

await test('persistence: first visit names you and saves; reload restores', async () => {
  const a = fresh();
  a.s.start();
  assert.match(a.cv.get('name'), /^ranger\d{3}$/);
  a.cv.set('fov', 115);
  a.bi.set('f', '+attack');
  a.co.save('duel', 'fov 100');
  await tick(10);
  const saved = JSON.parse(a.kv.getItem(LOCAL_KEY)!);
  assert.equal(saved.cvars.fov, '115');
  assert.equal(saved.binds.f, '+attack');
  assert.equal(saved.configs['duel.cfg'], 'fov 100');
  assert.ok(!('sensitivity' in saved.cvars), 'defaults are not stored');

  const b = fresh();
  b.kv.m = a.kv.m;
  b.s.start();
  assert.equal(b.cv.get('fov'), '115');
  assert.equal(b.cv.get('name'), a.cv.get('name'));
  assert.equal(b.bi.get('f'), '+attack');
  assert.equal(b.co.get('duel'), 'fov 100');
});

await test('vault: empty account is seeded; account copy wins; changes reach it; failures retry', async () => {
  const a = fresh();
  a.s.start();
  a.cv.set('sensitivity', 5);
  const v = new FakeVault();
  await a.s.attachVault(v);
  assert.equal(a.s.status(), 'account');
  assert.equal((v.doc[VAULT_KEY] as { cvars: Record<string, string> }).cvars.sensitivity, '5');
  a.cv.set('fov', 120);
  await tick(20);
  assert.equal((v.doc[VAULT_KEY] as { cvars: Record<string, string> }).cvars.fov, '120');
  const savesBefore = v.saves;

  // a second device with other local settings signs in: the account wins
  const b = fresh();
  b.s.start();
  b.cv.set('fov', 100);
  await b.s.attachVault(v);
  assert.equal(b.cv.get('fov'), '120');
  assert.equal(b.cv.get('sensitivity'), '5');
  assert.equal(JSON.parse(b.kv.getItem(LOCAL_KEY)!).cvars.fov, '120', 'local mirror updated');

  // a failing save is retried on the next change
  v.fail = true;
  b.cv.set('volume', 0.2);
  await tick(20);
  v.fail = false;
  b.cv.set('volume', 0.3);
  await tick(20);
  assert.equal((v.doc[VAULT_KEY] as { cvars: Record<string, string> }).cvars.volume, '0.3');
  assert.ok(v.saves > savesBefore);

  await b.s.detachVault();
  assert.equal(b.s.status(), 'browser');
  const s0 = v.saves;
  b.cv.set('volume', 0.9);
  await tick(20);
  assert.equal(v.saves, s0, 'nothing reaches the account after sign-out');
});

await test('cfg text round trip', () => {
  const a = fresh();
  a.cv.set('fov', 112);
  a.bi.set('x', 'say "hi there"');
  const text = a.s.exportText();
  const b = fresh();
  const skipped = b.s.importText(text + '\nexec foo.cfg; seta sensitivity 7 // comment\nbind q "impulse 7; wait"');
  assert.equal(b.cv.get('fov'), '112');
  assert.equal(b.cv.get('sensitivity'), '7');
  assert.equal(b.bi.get('w'), '+forward');
  assert.equal(b.bi.get('x'), 'say hi there');
  assert.equal(b.bi.get('q'), 'impulse 7; wait');
  assert.deepEqual(skipped, ['exec foo.cfg']);
  assert.deepEqual(tokenize('bind "a b" c'), ['bind', 'a b', 'c']);
  assert.deepEqual(splitStatements('a; b "c;d"'), ['a', 'b "c;d"']);
});

await test('palette rows', () => {
  assert.equal(paletteCss(0), '#000000');
  assert.equal(paletteCss(15), '#ebebeb');
  assert.equal(PALETTE_ROWS.length, 14);
  // rows 8+ run bright→dark in the palette; the ramp is darkest first for every row
  for (const r of [4, 13]) {
    const ramp = rowRamp(r).map((h) => parseInt(h.slice(1, 3), 16) + parseInt(h.slice(3, 5), 16) + parseInt(h.slice(5, 7), 16));
    assert.ok(ramp[0] < ramp[15], `row ${r}`);
  }
});

console.log(`settings: ${n} tests passed`);
