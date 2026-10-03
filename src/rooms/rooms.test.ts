/**
 * Rooms unit tests:  npx tsx src/rooms/rooms.test.ts
 */
import assert from './assert.test-util.js';
import {
  MAP_DICT, MAX_ROOM_ID, MODES, MODE_ORDER, REGIONS, RoomConfigError, decodeRoomId, defaultConfig, encodeRoomId,
  makePasswordCheck, parseInfo, passwordMatches, planRooms, quickPlay, roomFromHash, standingConfig, toRows,
  toServerinfo, withStanding, b64urlEncode, encodeConfig, officialRotation, roomLink, botsEstimate,
  type RoomConfig,
} from './index.js';

let n = 0;
const test = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); n++; } catch (err) { console.error(`FAIL ${name}`); throw err; }
};

await test('round trip every mode × region with defaults', () => {
  for (const mode of MODE_ORDER) for (const region of [null, ...REGIONS.map((r) => r.id)]) {
    const c = defaultConfig(mode, { region, rotation: MODES[mode].rotation.length ? [...MODES[mode].rotation] : ['qt_ctf1'] });
    const id = encodeRoomId(c);
    assert.ok(id.startsWith('qt1.') && id.endsWith('-quaketown'), id);
    assert.ok(id.length <= MAX_ROOM_ID);
    assert.deepEqual(decodeRoomId(id), c);
  }
});

const full: RoomConfig = {
  name: 'Frag Fest «ünïcode» ☠', region: 'eu', mode: '4on4', timelimit: 20, fraglimit: 300, maxclients: 32,
  bots: true, rotation: ['lqdm3', 'custom_map-2', 'qt_aero'], standing: false,
  mod: { id: 'abcdef012345', url: 'https://example.org/mods/kt.pk3' },
  packs: [{ id: '0123456789ab' }, { id: 'ffffffffffff', url: 'http://localhost:8000/p.pk3' }],
  password: { salt: '00112233', check: 'deadbeef' },
};

await test('round trip everything set, unicode name, literal maps, urls, password', () => {
  const id = encodeRoomId(full);
  assert.deepEqual(decodeRoomId(id), full);
  console.log(`  full config id: ${id.length} chars`);
});

await test('standing room ids are short', () => {
  const c = standingConfig('asia', 'ffa', 1)!;
  const id = encodeRoomId(c);
  assert.ok(id.length < 60, `${id.length}: ${id}`);
  console.log(`  standing id: ${id}`);
});

await test('too long is refused with a sentence', () => {
  const c = { ...full, packs: Array.from({ length: 4 }, (_, i) => ({ id: `00000000000${i}`, url: `https://example.org/${'x'.repeat(60)}/${i}.pk3` })) };
  assert.throws(() => encodeRoomId(c), (e: unknown) => e instanceof RoomConfigError && /characters/.test((e as Error).message));
});

await test('validation', () => {
  assert.throws(() => encodeRoomId({ ...full, maxclients: 33 }), RoomConfigError);
  assert.throws(() => encodeRoomId({ ...full, maxclients: 1 }), RoomConfigError);
  assert.throws(() => encodeRoomId({ ...full, rotation: [] }), RoomConfigError);
  assert.throws(() => encodeRoomId({ ...full, rotation: ['Bad Map'] }), RoomConfigError);
  assert.throws(() => encodeRoomId({ ...full, name: 'a\\b' }), RoomConfigError);
  assert.throws(() => encodeRoomId({ ...full, name: '' }), RoomConfigError);
  assert.throws(() => encodeRoomId({ ...full, mod: { id: 'xyz' } }), RoomConfigError);
});

await test('garbage and non-canonical ids decode to null', () => {
  const id = encodeRoomId(full);
  for (const bad of ['', 'hello', 'qt1.-quaketown', 'qt1.!!!!-quaketown', 'qt2' + id.slice(3), id + 'x', id.replace('-quaketown', '-freedm'),
    'qt1.' + 'A'.repeat(300) + '-quaketown']) {
    assert.equal(decodeRoomId(bad), null, bad);
  }
  // trailing byte
  const bytes = encodeConfig(full);
  const longer = new Uint8Array(bytes.length + 1); longer.set(bytes);
  assert.equal(decodeRoomId(`qt1.${b64urlEncode(longer)}-quaketown`), null);
  // every truncation
  for (let i = 0; i < bytes.length; i++) assert.equal(decodeRoomId(`qt1.${b64urlEncode(bytes.subarray(0, i))}-quaketown`), null);
  // random fuzz never throws
  for (let i = 0; i < 5000; i++) {
    const r = new Uint8Array(1 + (i % 40)); for (let k = 0; k < r.length; k++) r[k] = Math.floor(Math.random() * 256);
    const c = decodeRoomId(`qt1.${b64urlEncode(r)}-quaketown`);
    if (c) assert.deepEqual(decodeRoomId(encodeRoomId(c)), c);
  }
  // a dictionary map spelled as a literal is not canonical
  const lit = encodeConfig({ ...full, rotation: ['zz_lqdm1'] });
  const at = [...lit].findIndex((_, k) => lit[k] === 8 && String.fromCharCode(...lit.subarray(k + 1, k + 9)) === 'zz_lqdm1');
  assert.ok(at > 0);
});

await test('map dictionary codes are stable', () => {
  assert.equal(MAP_DICT[0], 'lqdm1');
  assert.equal(MAP_DICT[12], 'lqdm13');
  assert.equal(MAP_DICT.length, new Set(MAP_DICT).size);
});

await test('serverinfo', () => {
  const c = defaultConfig('duel', { name: 'Duel "1" \\ here', rotation: ['lqdm11', 'lqdm12'], region: 'na' });
  // the name is cleaned by the host screen; serverinfo strips anyway
  const info = toServerinfo({ ...c, name: 'Duel 1' });
  assert.equal(info, '\\*qt\\1\\hostname\\Duel 1\\mode\\duel\\deathmatch\\3\\teamplay\\0\\timelimit\\10\\fraglimit\\0\\maxclients\\2\\bots\\0\\rotation\\lqdm11 lqdm12\\samelevel\\0\\watervis\\0\\region\\na\\overtime\\3');
  const kv = parseInfo(toServerinfo(c));
  assert.equal(kv.get('hostname'), 'Duel 1  here');
  const ca = parseInfo(toServerinfo(defaultConfig('ca')));
  assert.equal(ca.get('rounds'), '7');
  assert.equal(ca.get('teamplay'), '1');
  const four = parseInfo(toServerinfo(defaultConfig('4on4')));
  assert.equal(four.get('deathmatch'), '1');
  assert.equal(four.get('teamplay'), '2');
});

await test('password check', async () => {
  const pw = await makePasswordCheck('hunter2');
  assert.match(pw.salt, /^[0-9a-f]{8}$/);
  assert.ok(await passwordMatches(pw, 'hunter2'));
  assert.ok(!(await passwordMatches(pw, 'hunter3')));
  const fixed = await makePasswordCheck('x', '00000000');
  assert.equal(fixed.check, (await makePasswordCheck('x', '00000000')).check);
});

await test('plan: standing always, overflow at 80% humans', () => {
  assert.deepEqual(planRooms(new Map(), 16), [1]);
  assert.deepEqual(planRooms(new Map([[1, 12]]), 16), [1]);
  assert.deepEqual(planRooms(new Map([[1, 13]]), 16), [1, 2]);
  assert.deepEqual(planRooms(new Map([[1, 13], [2, 3]]), 16), [1, 2]);
  assert.deepEqual(planRooms(new Map([[1, 2], [3, 1]]), 16), [1, 3]);
  assert.deepEqual(planRooms(new Map([[1, 2]]), 2), [1, 2]);
});

await test('listing: standing rows for every region × mode with maps, real counts, no fake population', () => {
  const ffaEu = encodeRoomId(standingConfig('eu', 'ffa', 1)!);
  const custom = encodeRoomId({ ...full, password: null });
  const rows = withStanding(toRows([
    { id: ffaEu, clientCount: 14, authorityNodeId: 'node_abc', createdAt: new Date(Date.now() - 600_000).toISOString() },
    { id: custom, clientCount: 3, authorityNodeId: 'node_def', createdAt: 'x' },
    { id: 'na-1-freedm', clientCount: 9, authorityNodeId: 'n', createdAt: '' },
  ]));
  const standing = rows.filter((r) => r.config.standing);
  // ctf has no maps in the static table and no index → not listed
  assert.equal(standing.filter((r) => r.standingIndex === 1).length, REGIONS.length * (MODE_ORDER.length - 1));
  const eu = rows.find((r) => r.roomId === ffaEu)!;
  assert.equal(eu.humans, 14);
  assert.equal(eu.bots, 2);
  assert.equal(eu.live, true);
  // 14/16 > 80% → EU FFA 2 opened
  assert.ok(rows.some((r) => r.config.name === 'EU FFA 2' && !r.live));
  assert.ok(!rows.some((r) => r.config.name === 'NA FFA 2'));
  const c = rows.find((r) => r.roomId === custom)!;
  assert.equal(c.humans, 3); assert.equal(c.bots, 29);
  assert.ok(!rows.some((r) => r.roomId === 'na-1-freedm'));
  const duel = rows.find((r) => r.config.name === 'NA Duel 1')!;
  assert.equal(duel.bots, 0);
  assert.equal(botsEstimate(duel.config, 1), 0);
});

await test('ctf standing rooms come from the index', () => {
  const index = [{ id: 'x', name: 'maps-qt', kind: 'maps', bytes: 1, maps: [{ name: 'qt_ctf1', modes: ['ctf'] }, { name: 'qt_aero', modes: ['ffa'] }] }];
  assert.deepEqual(officialRotation('ctf', index), ['qt_ctf1']);
  const rows = withStanding([], index);
  assert.equal(rows.filter((r) => r.config.mode === 'ctf').length, REGIONS.length);
});

await test('quick play prefers the busiest open public room', () => {
  const a = encodeRoomId(standingConfig('na', 'ffa', 1)!);
  const b = encodeRoomId({ ...defaultConfig('ffa'), name: 'pub', region: 'na' });
  const p = encodeRoomId({ ...defaultConfig('ffa'), name: 'priv', region: 'na', password: { salt: '00000000', check: '00000000' } });
  const rows = withStanding(toRows([
    { id: a, clientCount: 4, authorityNodeId: 'n1', createdAt: '' },
    { id: b, clientCount: 9, authorityNodeId: 'n1', createdAt: '' },
    { id: p, clientCount: 12, authorityNodeId: 'n1', createdAt: '' },
  ]));
  assert.equal(quickPlay(rows, 'na', 'ffa')!.roomId, b);
  assert.equal(quickPlay([], 'eu', 'duel')!.config.name, 'EU Duel 1');
});

await test('hash and link', () => {
  const id = encodeRoomId(full);
  assert.equal(roomFromHash(`#room=${id}`)!.roomId, id);
  assert.equal(roomFromHash(`#${id}`)!.roomId, id);
  assert.equal(roomFromHash('#room=junk'), null);
  assert.equal(roomFromHash(new URL(roomLink(id, 'https://x.test/play?a=1')).hash)!.roomId, id);
});

console.log(`rooms: ${n} tests passed`);
