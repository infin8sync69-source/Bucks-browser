// New-tab page logic (widget board, clock, agenda, profile): plain TypeScript, run by Node directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BOARD, MAX_WIDGETS, MAX_NOTES, sanitizeBoard, addWidget, removeWidget, moveWidget, updateConfig,
  sortAgenda, agendaFor, parseAgendaEntry, withAgendaItem, withAgendaToggled, withoutAgendaItem,
  greeting, zoneCity, timeIn, validTimeZone, dayKey,
} from '../../../ui/src/lib/newtab/board.ts';
import { cleanProfile, nameError, initial, contactCard, parseContactCard, MAX_NAME } from '../../../ui/src/lib/newtab/profile.ts';

test('sanitizeBoard drops unknown widgets and bad fields, keeps order, de-duplicates ids', () => {
  assert.deepEqual(sanitizeBoard(null), DEFAULT_BOARD);
  assert.deepEqual(sanitizeBoard({ widgets: 'x' }), DEFAULT_BOARD);
  const b = sanitizeBoard({
    widgets: [
      { uid: 'a', type: 'markets', config: {} },
      { uid: 'a', type: 'clock', config: { zones: ['Europe/Lisbon', 'Mars/Olympus', 7, 'Asia/Tokyo'] } },
      { uid: 'a', type: 'notes', config: { text: 'x'.repeat(MAX_NOTES + 10) } },
      { type: 'weather', config: { city: '  Porto  ' } },
      { uid: 'd', type: 'today', config: { day: '2026-10-18', items: [{ id: 'i1', time: '25:00', text: ' Call ', done: 'yes' }, { text: '' }, 'junk'] } },
    ],
  });
  assert.deepEqual(b.widgets.map((w) => w.type), ['clock', 'notes', 'weather', 'today']);
  assert.equal(b.widgets[0].uid, 'a');
  assert.equal(new Set(b.widgets.map((w) => w.uid)).size, 4);
  assert.deepEqual(b.widgets[0].config.zones, ['Europe/Lisbon', 'Asia/Tokyo']);
  assert.equal(b.widgets[1].config.text.length, MAX_NOTES);
  assert.equal(b.widgets[2].config.city, 'Porto');
  assert.deepEqual(b.widgets[3].config.items, [{ id: 'i1', time: '', text: 'Call', done: false }]);
});

test('add, remove, move and configure widgets', () => {
  let b = { widgets: [] };
  b = addWidget(b, 'clock');
  b = addWidget(b, 'weather');
  b = addWidget(b, 'notes');
  b = addWidget(b, 'nope');
  assert.deepEqual(b.widgets.map((w) => w.type), ['clock', 'weather', 'notes']);
  const [clock, weather, notes] = b.widgets;
  assert.deepEqual(moveWidget(b, notes.uid, 0).widgets.map((w) => w.type), ['notes', 'clock', 'weather']);
  assert.deepEqual(moveWidget(b, clock.uid, 99).widgets.map((w) => w.type), ['weather', 'notes', 'clock']);
  assert.equal(moveWidget(b, 'missing', 0), b);
  b = updateConfig(b, weather.uid, { city: 'Lisbon' });
  assert.equal(b.widgets[1].config.city, 'Lisbon');
  b = updateConfig(b, clock.uid, { zones: ['UTC', 'not/a zone'] });
  assert.deepEqual(b.widgets[0].config.zones, ['UTC']);
  assert.deepEqual(removeWidget(b, weather.uid).widgets.map((w) => w.type), ['clock', 'notes']);
  let full = { widgets: [] };
  for (let i = 0; i < MAX_WIDGETS + 3; i++) full = addWidget(full, 'notes');
  assert.equal(full.widgets.length, MAX_WIDGETS);
});

test('the agenda: parsing, ordering, and a new day starts empty', () => {
  assert.deepEqual({ ...parseAgendaEntry('9:30 Standup'), id: 'x' }, { id: 'x', time: '09:30', text: 'Standup', done: false });
  assert.equal(parseAgendaEntry('14.05 Call').time, '14:05');
  assert.equal(parseAgendaEntry('7h00 Run').time, '07:00');
  assert.deepEqual({ ...parseAgendaEntry('25:00 nope'), id: 'x' }, { id: 'x', time: '', text: '25:00 nope', done: false });
  assert.equal(parseAgendaEntry('   '), null);

  const items = [
    { id: '1', time: '', text: 'Buy milk', done: false },
    { id: '2', time: '14:00', text: 'Call', done: false },
    { id: '3', time: '09:00', text: 'Standup', done: false },
  ];
  assert.deepEqual(sortAgenda(items).map((i) => i.id), ['3', '2', '1']);
  assert.deepEqual(agendaFor({ day: '2026-10-17', items }, '2026-10-18'), []);
  assert.equal(agendaFor({ day: '2026-10-18', items }, '2026-10-18').length, 3);

  let c = { day: '2026-10-17', items };
  c = withAgendaItem(c, { id: '4', time: '', text: 'New day', done: false }, '2026-10-18');
  assert.deepEqual(c, { day: '2026-10-18', items: [{ id: '4', time: '', text: 'New day', done: false }] });
  c = withAgendaToggled(c, '4', '2026-10-18');
  assert.equal(c.items[0].done, true);
  assert.deepEqual(withoutAgendaItem(c, '4', '2026-10-18').items, []);
  assert.match(dayKey(new Date(2026, 0, 5)), /^2026-01-05$/);
});

test('clock helpers', () => {
  assert.deepEqual([3, 8, 13, 20].map(greeting), ['Good night', 'Good morning', 'Good afternoon', 'Good evening']);
  assert.equal(zoneCity('America/Argentina/Buenos_Aires'), 'Buenos Aires');
  assert.equal(validTimeZone('Asia/Tokyo'), true);
  assert.equal(validTimeZone('Nowhere/Land'), false);
  assert.equal(validTimeZone(''), false);
  // 23:30 UTC is already the next day in Tokyo (UTC+9) and still the same day in New York.
  const at = new Date(Date.UTC(2026, 9, 18, 23, 30));
  const tokyo = timeIn('Asia/Tokyo', at);
  assert.equal(tokyo.time, '08:30');
  assert.equal(timeIn('UTC', at).time, '23:30');
  const utcDay = timeIn('UTC', at).dayOffset;
  assert.equal(tokyo.dayOffset - utcDay, 1);
});

test('profile: cleaning, validation, avatar letter and contact cards', () => {
  assert.deepEqual(cleanProfile(null), { name: '', bio: '' });
  assert.deepEqual(cleanProfile({ name: '  Ada   Lovelace ', bio: 7 }), { name: 'Ada Lovelace', bio: '' });
  assert.equal(cleanProfile({ name: 'x'.repeat(50) }).name.length, MAX_NAME);
  assert.equal(nameError(''), 'Type a name');
  assert.match(nameError('x'.repeat(31)), /At most 30/);
  assert.equal(nameError('Ada'), '');
  assert.equal(initial('ada'), 'A');
  assert.equal(initial(''), 'B');
  assert.equal(initial('éa'), 'É');

  const peer = '12D3KooWQYhTNQdmr3ArTeUHRYzFg94BKyTkoWBDWez9kSCVe2Xo';
  const card = contactCard(peer, 'Ada & Co');
  assert.equal(card, `bucks://user/${peer}?name=Ada%20%26%20Co`);
  assert.deepEqual(parseContactCard(card), { peerId: peer, name: 'Ada & Co' });
  assert.deepEqual(parseContactCard(`bucks://user/${peer}`), { peerId: peer, name: '' });
  assert.equal(parseContactCard('bucks://user/not-a-peer'), null);
  assert.equal(parseContactCard(`https://evil.example/${peer}`), null);
});
