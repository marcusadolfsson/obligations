/**
 * Renders every page in a real browser at iPhone width and fails on overflow.
 *
 * The structural checks in layout.test.mjs catch the mistakes I can name. This
 * catches the ones I cannot: a long word, a min-width deep in a flex chain, a
 * button row that does not wrap. Alex found a three-column table on his phone
 * that was invisible from here, and "test it on a phone" is not a thing I can
 * do — so this is the substitute.
 *
 * Pages are served by a stub HTTP server rather than loaded from disk, so the
 * API-driven parts render with real content: an obligations list showing "could
 * not load" would prove nothing about the layout of an obligations list.
 *
 * Run:  ./deploy/visual.sh
 */
import { createServer } from 'node:http';
import { readFile, mkdir, readdir } from 'node:fs/promises';
import { chromium, devices } from 'playwright';
import { PAGE } from './ui.mjs';
import { DASH_PAGES } from './dashboard.mjs';

const OBLIGATIONS = process.env.OBLIGATIONS ?? '/obligations';
// SCHEME=light renders the other palette into its own folder. The suite runs
// dark by default because that is what his phone is at 07:00; the light set is
// for looking, whenever the look changes.
const SCHEME = process.env.SCHEME === 'light' ? 'light' : 'dark';
const SHOTS = `${OBLIGATIONS}/.log/screens${SCHEME === 'light' ? '-light' : ''}`;

let pass = 0, fail = 0;
const ok = (m) => { console.log(`  ok   ${m}`); pass++; };
const bad = (m, d) => { console.log(`  FAIL ${m}${d ? '\n         ' + d : ''}`); fail++; };

/* ------------------------------------------------------------- stub server */

const API = {
  // Today, people and priorities: enough to render real cards, so the screenshot
  // shows the page rather than its error state.
  '/api/today': {
    outbox: { texts: 1, mail: 1 },
    generated_at: '2026-08-29 07:05', health: [], approvals: [],
    events: [{ id: 'e1', summary: 'PHOA — Industry Day design', startsAt: '2026-08-29 14:00', endsAt: '2026-08-29 15:00',
               location: 'The Hangar', mine: true, myResponse: 'accepted', prep: 'x.md',
               attendees: [{ email: 'me@x', self: true }, { email: 'hank@phoa.example', self: false, organizer: true }] },
             { id: 'e2', summary: "Mom works (can't watch Noah)", allDay: true, startsOn: '2026-08-29', mine: false, calendar: 'Mia', attendees: [] }],
    decisions: [{ id: 'decision:1', title: 'Cabinetry vendor for ONE 2201/2202', due: '2026-09-12', overdue: false, tags: ['decision', 'one'],
                  evidence: [{ source: 'decision', detail: { recommend: 'Summitline — only bid with install', blocked: 'comparable totals', options: ['a', 'b', 'c', 'd', 'e'] } }] }],
    due: [{ id: 'a1', title: 'Justworks hours before 14:00', who: 'noreply@coaefd.example', due: '2026-08-29 14:00', overdue: false, days: 1, owed_by: 'me', tags: [], evidence: [] },
          { id: 'a2', title: 'Fund the Fund I capital call', who: 'riverton@carta.example', due: '2026-08-28', overdue: true, days: 3, owed_by: 'me', tags: ['acme'], evidence: [] }],
    waiting: [{ id: 'w1', title: 'Tell Sunrise Nannies the Funland slot is covered', who: 'info@sunrise-nannies.example', days: 0, due: null, overdue: false, owed_by: 'me', tags: [], evidence: [{ source: 'email', detail: {} }] }],
    priorities: [{ title: 'ONE 2201/2202 renovation', tag: 'one', open: 1, moved: true, summary: '1 undecided' },
                 { title: 'PHOA', tag: 'phoa', open: 2, moved: true, summary: '+2' },
                 { title: 'The assistant', tag: 'obligations', open: 0, moved: false, summary: '' }],
    unattached: { count: 174, of: 177, owedByMe: 149 },
    closed: [{ title: 'Answer Woodcraft Studio on their estimate', outcome: 'they spoke on 2026-09-03 16:11', agent: true, at: '07:05' }],
    briefs: [{ id: 'b.md', kind: 'brief', at: '2026-08-29 07:05', title: 'Morning brief — the PHOA invite is yours to send', read: true }],
  },
  /* Both circles, as people.mjs sends them since 2026-09-22: a people/ file,
     a contact he only texts, and a named person at a company who is neither.
     Organisations are never in `people` — they are counted in orgsHidden. */
  '/api/people': { people: [
    { key: 'hank-mercer', name: 'Hank Mercer', org: 'PHOA', role: '', how: 'Runs the board.', file: 'people/hank-mercer.md',
      handles: ['hank@phoa.example'], threads: 3, texts: 0, last: '2026-08-28 14:14', lastSubject: 'the hold', lastChannel: 'email', tiers: {},
      circle: 'yours', kind: 'person',
      owedByMe: [{ id: 'o1', title: 'the spec', days: 4, due: null, overdue: false }], owedByThem: [] },
    { key: 'contact:tom-rourke', name: 'Pete Rourke', org: '', role: '', how: '', file: null, contact: true,
      handles: ['+18135550142'], threads: 0, texts: 2, last: '2026-09-21 18:00', lastSubject: '', lastChannel: 'text', tiers: {},
      circle: 'yours', kind: 'person', owedByMe: [], owedByThem: [{ id: 'o3', title: 'Gym times for Thursday', days: 1, due: null, overdue: false }] },
    { key: 'hull.sharon@oliverco.example', name: 'Sharon Hart', org: '', role: '', how: '', file: null, handles: ['hull.sharon@oliverco.example'],
      threads: 5, texts: 0, last: '2026-08-27 09:00', lastSubject: 'Returns', lastChannel: 'email', tiers: {}, circle: 'others', kind: 'person',
      owedByMe: [], owedByThem: [{ id: 'o2', title: 'the return review', days: 9, due: null, overdue: false }] },
  ], counts: { total: 3, withFile: 1, repeatWithoutFile: 1, withOpen: 3, yours: 2, others: 1, orgsHidden: 514, machinesHidden: 228 } },
  '/api/priorities': { since: '2026-08-28 07:00',
    // Every project with a tag, so the editor can offer the ones that are not
    // the focus yet. Since 2026-09-16 a priority IS a project.
    all: [{ tag: 'one', title: 'ONE 2201/2202 renovation', name: 'one-2201-2202', file: 'projects/one-2201-2202.md', focus: 1, note: 'firm scope' },
          { tag: 'phoa', title: 'PHOA CRM', name: 'phoa-crm', file: 'projects/phoa-crm.md', focus: null, note: 'CRM working for Ruth' },
          { tag: 'locks', title: 'Locks', name: 'locks', file: 'projects/locks.md', focus: null, note: 'waiting list filling' }],
    priorities: [{ title: 'ONE renovation', tag: 'one', file: 'projects/one-2201-2202.md', focus: 1, note: 'firm scope', open: 1, closed: [], fresh: [], overdue: [],
                   dueSoon: [{ id: 'decision:1', title: 'Cabinetry vendor', due: '2026-09-12', days: 2, owed_by: 'me', overdue: false }],
                   undecided: [{ id: 'decision:1', title: 'Cabinetry vendor', due: '2026-09-12', days: 2, owed_by: 'me', overdue: false }], waitingOnThem: 0 }],
    unattached: { count: 174, of: 177, owedByMe: 149 } },
  '/models': { models: [
    { id: 'claude-opus-5', label: 'Opus 5', short: 'Opus', note: 'most capable' },
    { id: 'claude-sonnet-5', label: 'Sonnet 5', short: 'Sonnet', note: 'faster, cheaper' },
  ], default: 'claude-opus-5' },
  '/history': { sessionId: 'abcdefgh', from: 0, total: 3, more: false, messages: [
    { role: 'user', text: 'Who is waiting on my responses?' },
    { role: 'assistant', text: '## Waiting\n\n- **Clara (mother)** — owes her the cataract surgery date, 12 days\n- A supplier chasing an invoice with a very long unbroken reference NUMBER1234567890ABCDEFGHIJKLMNOP\n\nThat is everything.' },
    { role: 'tool', text: 'Read' },
  ] },
  // The digest: judged mail only, with the backlog line. The first item's
  // thread matches the '/api/reading/body' fixture so opening it shows text.
  /* Before '/api/digest', because the stub matches by prefix: marking read is
     a different endpoint with a different answer, and answering it with the
     digest payload made every mark-read look refused — the page reverted the
     flags AND the counts, so the pills never moved. */
  '/api/digest/read': { ok: true, changed: 1 },
  '/api/digest': { prose: { text: '## Worth opening\nThe SaunaCo agreement came back countersigned.\n\n## Everything else\n\nBills: Power Co, Justworks and a [Chase notice](/thread/personal/a1b2c3d4); the Spectrum $0 statement; Amex Delta Reserve ($12,607.74 balance, $102 due 10/9).\n\nNotices and orders: two FlightAware alerts for N123AB; an Apple iPhone 17 trade-in estimate ($785).', written_at: '2026-09-06 09:40', covers: 3, stale: false, writing: false, model: 'claude-sonnet-5',
    // What the prose actually narrated. Its Mark-read button covers these
    // and no more — the unread list is far longer than the digest.
    ids: ['personal:a1b2c3d4', 'personal:b2c3d4e5', 'personal:d4e5f6a7'] }, waiting: { count: 3, senders: ['alerts@flightaware.com'], due: false, why: null, list_at: '2026-09-06 00:06', stale: false, items: [
    { threadId: 'a1b2c3d4', account: 'personal', subject: 'Your FlightAware alert: N123AB', who: 'alerts@flightaware.com', reason: 'not seen before', since: null, signals: [] },
    { threadId: 'w2', account: 'work', subject: 'Re: Validation of account', who: null, reason: 'left the extract before it was ever judged', since: '2026-09-05 10:00', signals: [] },
  ] }, reason: null, counts: {}, groups: [], items: [
    { id: 'personal:a1b2c3d4', account: 'personal', threadId: 'a1b2c3d4', tier: 'digest', title: 'SaunaCo Spa Suite — signed agreement and deposit', subject: 'SaunaCo Spa Suite — signed agreement and deposit',
      what: 'The countersigned sauna agreement and the deposit receipt; nothing is owed until the framing questions are answered.', who: 'kyle@saunaco.example', at: '2026-09-05 16:10', when: '2026-09-05 16:10', read: false },
    { id: 'personal:b2c3d4e5', account: 'personal', threadId: 'a1b2c3d4', tier: 'reading', title: 'Riverton Metro Business Journal weekend edition', subject: 'Riverton Metro Business Journal weekend edition',
      what: 'The weekend round-up from the local business paper; nothing addressed to him.', who: 'newsletters@bizweekly.example', at: '2026-09-05 09:00', when: '2026-09-05 09:00', read: false },
    { id: 'work:c3d4e5f6', account: 'work', threadId: 'c3d4e5f6', tier: 'digest', title: 'Your FlightAware alert: N123AB arrived KXYZ', subject: 'Your FlightAware alert: N123AB arrived KXYZ',
      what: 'An arrival alert; the aircraft is on the ground.', who: 'alerts@flightaware.com', at: '2026-09-04 18:40', when: '2026-09-04 18:40', read: true },
    { id: 'personal:d4e5f6a7', account: 'personal', threadId: 'd4e5f6a7', tier: 'digest', title: 'Your FlightAware alert: N123AB departed KXYZ', subject: 'Your FlightAware alert: N123AB departed KXYZ',
      what: 'A departure alert.', who: 'alerts@flightaware.com', at: '2026-09-04 12:05', when: '2026-09-04 12:05', read: false },
  ] },
  /* One dataset, sliced by the route. A read/unread mix across tiers, so the
     toggle has something to change and the per-tier counts differ from the
     totals. */
  '/api/filed': { items: [
    { id: 'personal:a1b2c3d4', account: 'personal', threadId: 'a1b2c3d4', tier: 'action', title: 'SaunaCo Spa Suite — signed agreement and deposit', subject: null, what: 'Signed; deposit paid.', who: 'kyle@saunaco.example', at: '2026-09-05 16:10', when: '2026-09-05 16:10', open: true, read: false },
    { id: 'personal:f1f2f3f4', account: 'personal', threadId: 'f1f2f3f4', tier: 'memory', title: 'Holiday Inn Express confirmation', subject: null, what: 'Confirmation 1234.', who: 'reservations@ihg.com', at: '2026-09-01 09:00', when: '2026-09-01 09:00', open: false, read: true },
    /* A second memory row, and deliberately `read: false`. The assistant read it
       and filed the fact; the page must still draw it with no unread rule and
       no bold — which is the thing a `:not(.read)` selector got wrong. */
    { id: 'personal:e5f6a7b8', account: 'personal', threadId: 'e5f6a7b8', tier: 'memory', title: 'DigiKey order confirmed, salesorder #100000001', subject: null, what: 'Order confirmation; $40.54. Nothing owed.', who: 'orders@digikey.com', at: '2026-09-02 14:20', when: '2026-09-02 14:20', open: false, read: false },
    { id: 'personal:b2c3d4e5', account: 'personal', threadId: 'b2c3d4e5', tier: 'reading', title: 'Riverton Metro Business Journal weekend edition', subject: null, what: 'The weekend round-up from the local business paper; nothing addressed to him.', who: 'newsletters@bizweekly.example', at: '2026-09-05 09:00', when: '2026-09-05 09:00', open: false, read: false, reviewed: '2026-09-05 09:10' },
    { id: 'work:c3d4e5f6', account: 'work', threadId: 'c3d4e5f6', tier: 'digest', title: 'Your FlightAware alert: N123AB arrived KXYZ', subject: null, what: 'An arrival alert; the aircraft is on the ground.', who: 'alerts@flightaware.com', at: '2026-09-04 18:40', when: '2026-09-04 18:40', open: false, read: true, reviewed: '2026-09-05 18:45' },
    { id: 'personal:d4e5f6a7', account: 'personal', threadId: 'd4e5f6a7', tier: 'digest', title: 'Your FlightAware alert: N123AB departed KXYZ', subject: null, what: 'A departure alert.', who: 'alerts@flightaware.com', at: '2026-09-04 12:05', when: '2026-09-04 12:05', open: false, read: false, reviewed: '2026-09-04 12:10' },
    // Silenced by his own ignore list: never in All, reachable by its own pill.
    { id: 'personal:s1l3nt00', account: 'personal', threadId: 's1l3nt00', tier: 'silent', title: 'Motley Fool promotional mail', subject: null, what: 'Silenced by the ignore list.', who: 'promo@fool.com', at: '2026-09-05 11:00', when: '2026-09-05 11:00', open: false, read: false },
  ] },
  '/api/messages': { unread: 1, messages: [
    { id: 'a.md', kind: 'brief', at: '2026-08-29 07:00', title: 'Morning brief — an Android phone at 09:30, and Noah\'s 17:00 visit is still unconfirmed', read: false, delivered: 'none',
      // A brief is markdown. The plain 'Body text.' this used to carry gave the
      // rendering check nothing to find once briefs had their own page.
      body: '**Your 09:30 GateLink call needs an Android handset** and there is not one in the room — the call is with Talia and Kyle, and neither has confirmed they are bringing one.\n\n### Today\n\n- **09:30 — GateLink call.** An Android handset in the room.\n- 17:00 — Noah at JH Childrens Hospital\'s, arrive 16:45.\n\n### Due today\n\n**Overdue:** Carta INV00100002, $16,717.75, 53 days over.\n\n### Waiting on others\n\n- **Hank Mercer** — the Morgan announcement, 3 days quiet.\n', },
    { id: 'b.md', kind: 'note', at: '2026-08-29 18:05', read: true, delivered: 'none',
      title: 'Orthopedic visit is Tuesday 13:15 — paperwork still not done',
      body: 'Sunday. Nothing due today, nothing on the calendar I can see.\n\n'
          + '**Next three days, all needing something from you first**\n\n'
          + '- **Tue 2026-09-01 13:15** — Garrett Miner, MD, Regional Orthopaedic\n'
          + '  South Cedar/Pines. Check-in link sent twice and the paperwork has\n'
          + '  to be done *before* the visit.\n'
          + '- **Wed 2026-09-02 17:00** — campaign kickoff. Still no RSVP.\n\n'
          + '**Waiting on you, longest first**\n\n'
          + '- Clara — cataract surgery booking for early October. 13 days.\n'
          + '- Neil Fairley — asked to talk about "a situation". 13 days.\n\n'
          + 'A quoted line, which should not read as the assistant\'s own voice:\n\n'
          + '> Please forgive the delay of my response. I will send first thing\n'
          + '> on Monday.\n' },
    { id: 'c.md', kind: 'failure', at: '2026-08-30 07:45', read: true, delivered: 'none',
      title: 'morning job did not run',
      // A failure alert is markdown like every other message. With `note` moved to
      // the briefs page this is the only notification left in the fixture, so it
      // has to carry something the rendering check can find.
      body: '**Expected slot** 2026-08-30T07:00 — nothing recorded by 07:45.\n\n- `obligations-agent` was up\n- `.log/job-runs.json` last shows 2026-08-29T07:00' },
  ] },
  // Before '/api/outbox', because the stub matches on the longest-standing
  // prefix and the count route would otherwise be answered by the page's own
  // payload — which is where the nav pill's "outbox (0[object Object])" in
  // every screenshot came from.
  '/api/outbox/count': { texts: 1, invites: 0, mail: 1, stale: 0 },
  '/api/outbox': { pending: 1, mailPending: 1, blind: [], outbox: [
    { id: 'd.md', kind: 'text', subject: null, account: null, editedAt: null, to: '+17275551234', toName: 'Anna Lindqvist', status: 'draft', created: '2026-08-29 08:00',
      text: 'Sorry for the slow reply — flights are 14 Oct out, 21 Oct back.',
      chatId: 'any;-;+17275551234', approvedAt: null, sentAt: null, error: null },
    { id: '2026-08-28-1200-mail-re-quote.md', kind: 'mail', subject: 'Re: Quote', account: 'personal', editedAt: null, to: 'vendor@example.com', status: 'sent',
      created: '2026-08-28 12:00', text: 'Thanks — go ahead.', chatId: null, approvedAt: '2026-08-28 12:00 by alex@rivera.example', sentAt: '2026-08-28 12:00', error: null },
  ], mail: [
    { kind: 'mail', id: 'r-1', account: 'personal', canSend: true, to: 'Sunrise Nannies <hello@sunrise-nannies.example>', cc: null,
      subject: 'Re: Sunrise Nannies Inquiry', threadId: 't1', inReplyTo: '<a@x>', snippet: 'Thanks for getting back',
      task: 'mail:personal:t1',
      text: 'Thanks for getting back to me — we ended up booking through another service for this trip, so no need to hold anything.\n\nAlex',
      updatedMs: Date.now() - 3600000, link: 'https://mail.google.com/mail/u/0/#drafts/m1' },
  ] },
  // A cached email, as /api/reading/body returns it. Defined ahead of
  // '/api/reading' because the stub matches keys by prefix, first wins.
  '/api/reading/body': { thread_id: 'a1b2c3d4', account: 'personal', cached: true,
    subject: 'SaunaCo Spa Suite — signed agreement and deposit',
    messages: [
      { html: '<div><h1>Weekend edition</h1><p>Top stories</p><script>alert(1)</script></div>',  id: 'x1', from: 'Kyle <kyle@saunaco.example>', date: 'Tue, 2 Sep 2026 09:14', subject: 's',
        text: 'Hi Alex,\n\nAttached is the signed agreement and the 50% deposit invoice for $6,983.64.\n\nThanks,\nKyle',
        truncated: false, attachments: [] },
    ] },
  /* Before '/api/reading', because the stub matches by prefix: the sender
     state is a record, and the reading list has a field of the same name that
     is a count. Answering one with the other rendered "stop ignoring
     undefined" on every thread. */
  '/api/reading/sender-state': { address: 'kyle@saunaco.example', ignored: null, reading: false },
  // What silencing would move — the numbers the confirmation panel reads.
  '/api/reading/ignore-preview': { address: 'kyle@saunaco.example', matched: 1825, inbox: 12, unread: 4 },
  '/api/reading': { senders: 55, ignored: 1, reason: null, items: [
    { id: 'm1', threadId: 'a1b2c3d4', account: 'personal', address: 'news@localpaper.example',
      from: 'The Gazette Newspaper',
      subject: 'Reef Grill is out on Harbor Point and a new restaurant is in',
      at: 1788010000000, url: 'https://mail.google.com/',
      snippet: 'Plus: the county commission votes on the pier extension, and a '
             + 'long unbroken token NEWSLETTERREF1234567890ABCDEFGHIJK' },
    // Two from one sender, so grouping has something to group.
    { id: 'm3', threadId: 'a1b2c3d5', account: 'personal', address: 'news@localpaper.example',
      from: 'The Gazette Newspaper', subject: 'Last week in Springfield',
      at: 1787400000000, url: 'https://mail.google.com/', snippet: 'Earlier.' },
    { id: 'm2', threadId: 'b2c3d4e5', account: 'personal', address: 'developer@apple.com',
      from: 'Apple Developer', subject: 'Xcode 27 beta 3 is available',
      at: 1787862868000, url: 'https://mail.google.com/', snippet: 'Download it now.' },
  ] },
  // The closed view: the last thirty days, newest first, with who and on what.
  '/api/obligations/closed': { updated: '2026-08-29 07:00', items: [
    { id: 'mail:personal:zz1', code: 'ZZ01', title: 'Pay the Summit Fuel invoice', what: 'Pay the Summit Fuel invoice', who: 'Summit Fuel', closed: true,
      closed_at: '2026-08-28 15:10', closed_by: 'agent:review', outcome: 'closes_when met: a receipt was filed on 2026-08-28', owed_by: 'me', days: 3, chat_id: null,
      evidence: [{ source: 'email', ref: 'mail:personal:zz1', open: false, detail: { thread_id: 'zz1', account: 'personal', link: '/thread/personal/zz1', subject: 'Summit Fuel — receipt' } }] },
    { id: 'todo:zz2', code: 'ZZ02', title: 'Book the dentist', what: 'Book the dentist', who: null, closed: true,
      closed_at: '2026-08-27 09:00', closed_by: 'alex@example.com', outcome: 'booked for the 3rd', owed_by: 'me', days: 5, chat_id: null,
      evidence: [{ source: 'todo', ref: 'todo:zz2', open: false }] },
  ] },
  '/api/obligations': { updated: '2026-08-29 07:00', items: [
    { id: 'rem:9f81', what: 'Re-run deploy/login.sh — the refresh token expires 2026-09-23',
      who: null, due: '2026-09-20 09:00', overdue: false, lead_days: 22, priority: 'low',
      owed_by: 'me', days: null, chat_id: null,
      evidence: [{ source: 'reminder', ref: 'rem:9f81', open: true }] },
    { id: 'recur:9a1c4f:2026-08',
      title: 'Aircraft hours: Northwind — N200BB, N300CC (2026-08)',
      what: 'Aircraft hours: Northwind — N200BB, N300CC (2026-08)',
      who: null, due: '2026-09-08 09:00', overdue: false, lead_days: 10, priority: 'normal',
      owed_by: 'me', days: null, chat_id: null,
      closes: 'receipt email from Northwind',
      evidence: [{ source: 'recurring', ref: 'recur:9a1c4f:2026-08', open: true }] },
    // One purchase spread over eight Gmail threads, five of them already
    // archived. This is the shape the page got wrong: it painted the word
    // "email" eight times and dropped every subject and every link.
    { id: 'mail:personal:t1',
      // Every real obligation has one — it is derived from the id, not
      // assigned — so a fixture without it was the unrealistic half.
      code: 'MT01',
      title: 'Pay the SaunaCo deposit',
      what: 'the SaunaCo Spa Suite purchase: he accepted and signed the sauna agreement on 2026-09-02 and the 50% deposit invoice is 6,983.64 USD, dated due the same day. Signed agreement filed. One purchase spread over eight Gmail threads, merged',
      who: 'kyle@saunaco.example', due: '2026-09-02', overdue: true, lead_days: -1,
      priority: 'high', owed_by: 'me', days: 0, chat_id: null,
      closes: 'the deposit is paid',
      evidence: [{ source: 'email', ref: `mail:personal:t1`, open: true, detail: { thread_id: `t1`, account: 'personal', link: `/thread/personal/t1`, subject: `SaunaCo Spa Suite — signed agreement and deposit` } }, { source: 'email', ref: `mail:personal:t2`, open: true, detail: { thread_id: `t2`, account: 'personal', link: `/thread/personal/t2`, subject: `SaunaCo deposit invoice` } }, { source: 'email', ref: `mail:personal:t3`, open: false, detail: { thread_id: `t3`, account: 'personal', link: `/thread/personal/t3`, subject: `Welcome to SaunaCo` } }, { source: 'email', ref: `mail:personal:t4`, open: false, detail: { thread_id: `t4`, account: 'personal', link: `/thread/personal/t4`, subject: `Spa Suite sauna — sizing thread` } }, { source: 'email', ref: `mail:personal:t5`, open: false, detail: { thread_id: `t5`, account: 'personal', link: `/thread/personal/t5`, subject: `Spa Suite sauna — dimensions confirmed` } }, { source: 'email', ref: `mail:personal:t6`, open: false, detail: { thread_id: `t6`, account: 'personal', link: `/thread/personal/t6`, subject: `Spa Suite sauna — earlier leg` } }, { source: 'email', ref: `mail:personal:t7`, open: false, detail: { thread_id: `t7`, account: 'personal', link: `/thread/personal/t7`, subject: `Spa Suite sauna — quote` } }, { source: 'email', ref: `mail:personal:t8`, open: true, detail: { thread_id: `t8`, account: 'personal', link: `/thread/personal/t8`, subject: `SaunaCo Spa Suite — layout exchange` } }] },
    { id: 'rem:c0de', what: 'renew the hangar insurance before the policy lapses',
      who: null, due: '2026-08-27 09:00', overdue: true, lead_days: -2, priority: 'high',
      owed_by: 'me', days: null, chat_id: null,
      evidence: [{ source: 'reminder', ref: 'rem:c0de', open: true }] },
    { id: 'c1', who: 'Clara (mother)', days: 12, priority: 'high', owed_by: 'me',
      what: 'owes her the cataract surgery date and the name of the surgeon she asked about twice',
      chat_id: 'c1', due: null,
      evidence: [{ source: 'imessage', ref: 'c1', open: true },
                 { source: 'todo', ref: 'todo:11', open: true }] },
    { id: 'c2', chat_id: 'c2', due: null,
      evidence: [{ source: 'imessage', ref: 'c2', open: true }], who: '+15552000015', days: 12, priority: 'normal', owed_by: 'me',
      what: "asked to connect for advice on 'a situation' during the week of 2026-08-17; never answered" },
    { id: 'c3', chat_id: 'c3', due: null,
      evidence: [{ source: 'imessage', ref: 'c3', open: true }], who: 'Pinecrest group', days: 7, priority: 'low', owed_by: 'me',
      what: 'confirm the dates' },
    { id: 'c4', chat_id: 'c4', due: null,
      evidence: [{ source: 'imessage', ref: 'c4', open: true }], who: '+15552000005', days: 3, priority: 'normal', owed_by: 'them',
      what: 'owes the lock-model audit — which NTM645/NR 626 units are left, sender label on the box' },
    { id: 'todo:aa11bb22cc33', who: null, days: 5, priority: 'high', owed_by: 'me',
      chat_id: null, due: null, tags: ['one'], code: 'K7QD',
      evidence: [{ source: 'todo', ref: 'todo:aa11bb22cc33', open: true, project: 'one' }],
      what: 'call the Coastal Eye Clinic surgery scheduler' },
    { id: 'todo:dd44ee55ff66', who: 'hank', days: 2, priority: 'normal', owed_by: 'them',
      chat_id: null, due: null, tags: ['phoa'], auto_tag: 'phoa', auto_why: 'hank is on phoa-crm',
      evidence: [{ source: 'todo', ref: 'todo:dd44ee55ff66', open: true }],
      what: 'chase the CRM setup instructions' },
  ] },
  // The registry behind the project grouping and the add form's picker.
  '/api/projects': { projects: [{ tag: 'phoa', name: 'phoa-crm', title: 'PHOA CRM', file: 'projects/phoa-crm.md', rules: 6 },
                                { tag: 'one', name: 'one-reno', title: 'ONE 2201/2202', file: 'projects/one-reno.md', rules: 2 }] },
  // The drill-down: the thread behind a task, and the box to answer it in.
  '/api/thread': {
    chat_id: 'c1', name: 'Clara (mother)', is_group: false,
    reply_to: '+17275551234',
    messages: [
      { at: '2026-08-17 09:02', from_me: false, who: 'Clara (mother)',
        text: 'Did the surgeon ever send the date for the cataract operation? I need to book the ride.' },
      { at: '2026-08-17 09:40', from_me: true, who: 'me', text: 'Checking, will confirm today' },
      { at: '2026-08-20 18:10', from_me: false, who: 'Clara (mother)',
        text: 'https://www.google.com/search?q=eye+dr+in+lecanto+fl&ie=UTF-8&oe=UTF-8&hl=en-us'
            + '&client=safari#sv=CAMSiwMa3wIKBmxjbF9wdhIrCgNwdnESJENnc3ZaeTh4WEdkbWNXNYb3lNaUlN'
            + 'Q2dabGVXVWdaSElRWhnQxLkAQoDbHFpEtwBQ2hSbGVXVWdaSElnYVc0Z2JHVmpZVzUwYjJZeA' },
      { at: '2026-08-20 18:11', from_me: false, who: 'Clara (mother)',
        text: 'Any news? Also see https://westcoasteye.com/patients/cataract-surgery.html' },
    ],
  },
  '/health': { ok: true, busy: false, sessionId: 'abcdefgh' },
};

const pages = { chat: PAGE };
for (const [path, render] of Object.entries(DASH_PAGES)) {
  pages[path.slice(1)] = await render(OBLIGATIONS, 1);
}

const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };

const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];

  if (path.startsWith('/assets/')) {
    const name = path.slice(8);
    try {
      const body = await readFile(new URL(`./web/${name}`, import.meta.url));
      res.writeHead(200, { 'Content-Type': TYPES[name.slice(name.lastIndexOf('.'))] ?? 'text/plain' });
      return res.end(body);
    } catch { res.writeHead(404); return res.end(); }
  }
  const api = Object.keys(API).find((k) => path === k) ?? Object.keys(API).find((k) => path.startsWith(k + '?') || path.startsWith(k));
  if (api) {
    let body = API[api];
    // The archive filters BY TIER ON THE SERVER since 2026-09-19, so the stub
    // has to as well — otherwise the test that a tier chip filters the history
    // passes against a stub that never filtered anything.
    if (api === '/api/filed') {
      // The real route slices one dataset by tier and by bucket, and reports
      // {total, unread} per tier. A stub that ignored either would let a
      // broken filter pass.
      const p = new URL(req.url, 'http://x').searchParams;
      const want = p.get('tier');
      const all = body.items ?? [];
      /* Only digest and reading have a reader, and `unread` comes back NULL for
         every other tier — not zero. The stub has to do that too, or the page's
         "show the total where there is no unread" branch is never exercised
         and a pill showing a forbidden number would pass. */
      const READABLE = ['reading', 'digest'];
      const viewOf = (k) => (k === 'reading' ? 'digest' : k);
      /* CURRENT vs NEVER, the same rule as digestlist.mjs. The fixture dates
         straddle the line on purpose: two threads judged after it are waiting
         for the next brief, the rest predate the mechanism. */
      const FROM = '2026-09-05 00:00';
      const bucketOf = (i) => (i.archivedInDigest ? 'archived'
        : String(i.reviewed ?? '') < FROM ? 'never' : 'current');
      const counts = {};
      let unreadTotal = 0, current = 0, never = 0;
      for (const i of all) {
        const v = viewOf(i.tier);
        counts[v] ??= { total: 0, unread: READABLE.includes(v) ? 0 : null };
        counts[v].total += 1;
        if (READABLE.includes(i.tier) && !i.read) { counts[v].unread += 1; unreadTotal += 1; }
        if (READABLE.includes(i.tier)) {
          const b = bucketOf(i);
          if (b === 'current') current += 1; else if (b === 'never') never += 1;
        }
      }
      counts.current = { total: current, unread: null };
      counts.never = { total: never, unread: null };
      // `silent` is out of All, and out of the All counts with it. `digest` is
      // a view over two tiers — newsletters live in it now, and `current` and
      // `never` are its two halves.
      const rows = (want === 'current' || want === 'never')
        ? all.filter((i) => READABLE.includes(i.tier) && bucketOf(i) === want)
        : want === 'digest' ? all.filter((i) => READABLE.includes(i.tier))
        : want ? all.filter((i) => i.tier === want)
        : all.filter((i) => i.tier !== 'silent');
      body = { ...body, total: all.filter((i) => i.tier !== 'silent').length, unreadTotal, counts,
               matching: rows.length, tier: want ?? null,
               items: rows.map((i) => ({ ...i, bucket: bucketOf(i) })) };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(body));
  }
  const page = path === '/' ? 'today' : path.slice(1);   // / is Today since 2026-09-05; chat is /chat
  if (pages[page]) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(pages[page]);
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

/* ------------------------------------------------------------------ render */

await mkdir(SHOTS, { recursive: true });
const browser = await chromium.launch();

/* Does anything stick out past the viewport?
 *
 * Called at BOTH states of a two-pane page, and that is the whole point. On a
 * phone the panes take turns — `.split.showing .list{display:none}` — so the
 * list is not in the layout once a message is selected. This probe used to run
 * only after the click, which measured a page the overflowing element had
 * already been removed from. Briefs shipped with every title running off the
 * right edge and the date pushed out of sight, and this guard called it ok. A
 * checker that cannot see half the page must say so rather than report the half
 * it can see. */
const overflow = async (page, name, label, state) => {
  const over = await page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    const wide = [...document.querySelectorAll('*')]
      .filter((el) => el.getBoundingClientRect().right > w + 1)
      .slice(0, 4)
      .map((el) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}` +
                   `${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/)[0] : ''}` +
                   ` right=${Math.round(el.getBoundingClientRect().right)}`);
    return { docWidth: document.documentElement.scrollWidth, viewport: w, wide };
  });
  if (over.docWidth <= over.viewport + 1) {
    ok(`${name} ${label}: no horizontal overflow, ${state} (${over.viewport}px)`);
  } else {
    bad(`${name} ${label}: page is ${over.docWidth}px wide in a ${over.viewport}px viewport, ${state}`,
        over.wide.join('\n         ') || '(no single element identified)');
  }
};

const ROUTES = [['today', '/'], ['chat', '/chat'],
  ...Object.keys(DASH_PAGES).map((p) => [p.slice(1), p])];

for (const [name, url] of ROUTES) {
  for (const [label, device] of [['iphone', devices['iPhone 13']], ['desktop', { viewport: { width: 1100, height: 900 } }]]) {
    const ctx = await browser.newContext({ ...device, colorScheme: SCHEME });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto(base + url, { waitUntil: 'networkidle' });
    await page.waitForTimeout(250);
    /* Chips are addressed by their words, never their position. Three separate
     * runs broke on `:nth-of-type` when the mail filter row was re-cut — which
     * tests the test, not the page. */
    const tap = async (text) => {
      const hit = await page.evaluate((t) => {
        // By address first (`group:sub`), then by the words on it.
        const c = document.querySelector(`#digfilters .chip[data-view="${t}"]`)
          ?? [...document.querySelectorAll('#digfilters .chip, #filt button')]
            .find((x) => (x.firstChild?.textContent ?? x.textContent ?? '').trim() === t);
        if (!c) return false;
        c.click();
        return true;
      }, text);
      if (!hit) bad(`${name} ${label}: no control labelled "${text}"`);
      await page.waitForTimeout(220);
      return hit;
    };

    // The message renders in the right pane once a row is selected, and the
    // pane is where the markdown rendering lives — an unselected screenshot
    // measures a layout nobody looks at. Click by selector: the list re-renders
    // on select, so a handle taken earlier would be detached.
    await overflow(page, name, label, 'showing the list');

    /* Rendered but invisible. On 2026-09-05 the people and digest lists held
     * every row in the DOM at 5px tall — a flex column shrinking its children —
     * and every check here passed, because none of them asked whether a row
     * could be seen. A list that has rows must show a row. */
    const firstRow = await page.evaluate(() => {
      const list = document.querySelector('.split > .list, .listcol .list, #today');
      if (!list) return null;
      // Direct rows of the list only — not rows inside a pane that is hidden by
      // design (reference keeps every trip's pane in the DOM, `hidden`). The
      // first one the layout places is the one measured.
      const rows = [...list.querySelectorAll('.ob, .card, .pri-line, .ref-row')].filter((r) => !r.closest('[hidden]'));
      const row = rows.find((r) => r.offsetParent !== null) ?? rows[0];
      if (!row) return { rows: 0 };
      const r = row.getBoundingClientRect();
      return { rows: rows.length, height: Math.round(r.height), visible: getComputedStyle(row).visibility, opacity: getComputedStyle(row).opacity };
    });
    if (firstRow && firstRow.rows > 0) {
      if (firstRow.height >= 24 && firstRow.visible !== 'hidden' && firstRow.opacity !== '0') ok(`${name} ${label}: rows are visible (first is ${firstRow.height}px)`);
      else bad(`${name} ${label}: ${firstRow.rows} rows in the DOM but the first is ${firstRow.height}px tall`, 'present but invisible — a shrinking flex column, or a hidden ancestor');
    }


    if (name === 'tasks') {
      // Two panes and a filter. The chips are the navigation, so all four must
      // be there; the fixture's items span today and no-date, so the default
      // chip (today) shows some and the rest sit behind other chips.
      const filters = await page.$$('#filt button');
      if (filters.length === 4) ok(`${name} ${label}: four filter chips`);
      else bad(`${name} ${label}: expected 4 filter chips, got ${filters.length}`);
      // Sort by days, either way, at the top of the left column; browse by tag.
      const sorts = await page.$$('#sortbar button');
      // Due date, priority, oldest, newest (Alex, 2026-10-03).
      if (sorts.length === 4) ok(`${name} ${label}: four sorts at the top of the list`);
      else bad(`${name} ${label}: expected 4 sort buttons, got ${sorts.length}`);
      // The tag dropdown became a project filter, on the Projects tab only (2026-10-04).
      const tagselHidden = await page.$eval('#tagsel', (n) => n.hidden).catch(() => null);
      if (tagselHidden === true) ok(`${name} ${label}: no tag dropdown off the Projects tab`);
      else bad(`${name} ${label}: the project filter shows off the Projects tab`, String(tagselHidden));

      // Selecting a row fills the RIGHT pane; the row itself no longer expands.
      // A message-backed row reaches the reply box, a mail-backed one its threads.
      // The fixture's message-backed items are undated, so switch to that chip.
      const nodate = await page.$('#filt button[data-f=nodate]');
      if (nodate) { await nodate.click(); await page.waitForTimeout(150); }
      const chat = await page.$('.ob[data-chat] .ob-title');
      if (chat) { await chat.click(); await page.waitForTimeout(300); }
      const box = await page.$('#taskpane .replybox textarea');
      if (box) ok(`${name} ${label}: selecting a message task shows its thread and a reply box in the pane`);
      else bad(`${name} ${label}: no reply box in the pane after selecting a message task`);

      const today = await page.$('#filt button[data-f=today]');
      if (today) { await today.click(); await page.waitForTimeout(150); }
      const mail = await page.$('.ob[data-mail] .ob-title');
      if (mail) { await mail.click(); await page.waitForTimeout(300); }
      const links = await page.$$('#taskpane .ob-ev .ob-evrow');
      if (links.length) ok(`${name} ${label}: a mail task lists its threads in the pane (${links.length})`);
      else bad(`${name} ${label}: mail task selected but no thread links in the pane`);


      // Alex: "when you open a cached email, it opens below it." Clicking an
      // evidence row must render the thread's text right under that row, in the
      // pane, without leaving the page.
      if (links.length) { await links[0].click(); await page.waitForTimeout(300); }
      const body = await page.$('#taskpane .mailbody:not([hidden]) .read-body');
      if (body) ok(`${name} ${label}: a cached email opens below its evidence row`);
      else bad(`${name} ${label}: clicking an evidence row did not open the email inline`);

      // The bug that started this: eight pieces of evidence rendered as the word
      // "email" eight times. One chip per source, with a count.
      const chips = await page.$$eval('.ob[data-mail="8"] .ob-src',
        (els) => els.map((e) => e.textContent));
      if (!chips.length || chips.some((c) => /^\d+ threads$/.test(c))) {
        ok(`${name} ${label}: multi-thread evidence is counted, not repeated`);
      } else {
        bad(`${name} ${label}: evidence chips repeated instead of counted (${chips.join(', ')})`);
      }
    }

    if (name === 'tasks') {
      // The floating button in the corner opens the drawer over the page.
      const fab = await page.$('.chatfab');
      if (fab) { await fab.click(); await page.waitForTimeout(400); }
      const frame = await page.$('.chatdrawer.open iframe.chatdrawer-frame');
      if (frame) ok(`${name} ${label}: the corner button opens the drawer with the chat inside`);
      else bad(`${name} ${label}: clicking the corner button did not open the drawer`);
      // While the drawer is open the toggle must not sit on top of it. The
      // drawer's composer pins its send button to the bottom-right corner —
      // exactly where the toggle lives — and the dodge that moved it aside only
      // ever fired at 60rem+. Below that it covered the send button, on a phone
      // and on a tablet alike. Either it is hidden or it is clear of the
      // drawer's left edge; both are fine, overlapping is not.
      const clash = await page.evaluate(() => {
        const f = document.querySelector('.chatfab');
        const d = document.querySelector('.chatdrawer.open');
        if (!d) return null;
        if (!f || getComputedStyle(f).display === 'none') return { hidden: true };
        const a = f.getBoundingClientRect(), b = d.getBoundingClientRect();
        return { hidden: false, over: a.right > b.left && a.left < b.right
                                     && a.bottom > b.top && a.top < b.bottom,
                 fab: Math.round(a.left), drawer: Math.round(b.left) };
      });
      if (!clash) bad(`${name} ${label}: no open drawer to measure the toggle against`);
      else if (clash.hidden) ok(`${name} ${label}: the toggle is hidden behind the open drawer`);
      else if (!clash.over) ok(`${name} ${label}: the toggle sits clear of the drawer (${clash.fab} < ${clash.drawer})`);
      else bad(`${name} ${label}: the chat toggle covers the drawer's send button`,
               `toggle left=${clash.fab}, drawer left=${clash.drawer}`);

      const x = await page.$('.chatdrawer-close');
      if (x) { await x.click(); await page.waitForTimeout(300); }

      // The list column is drawn to the bottom of the window even with four rows.
      if (label === 'desktop') {
        const h = await page.evaluate(() => {
          // The left column is .listcol where there is a sort bar (tasks) and the
          // bare .list where there is not (reading); the divider belongs to
          // whichever is the direct child of the split.
          const l = document.querySelector('.wrap.wide .split > .listcol, .wrap.wide .split > .list');
          const sp = document.querySelector('.wrap.wide .split');
          return l && sp ? [l.getBoundingClientRect().height, sp.getBoundingClientRect().height] : null;
        });
        if (h && h[0] >= h[1] * 0.95) ok(`${name} ${label}: the list column reaches the bottom (${Math.round(h[0])}/${Math.round(h[1])}px)`);
        else bad(`${name} ${label}: list column stops short: ${h ? h.map(Math.round).join('/') : 'n/a'}`);
      }
    }

    // Briefs: every unprompted message, full text on tap. Reminder pushes are
    // records, off the default view. Alex, 2026-09-06.
    if (name === 'mail') {
      // Opening an item must not pull it out of the list. Alex, 2026-09-19,
      // of the digest: "and it disappears once you open it."
      const beforeRows = await page.$$eval('#diglist .card', (cs) => cs.length);
      await page.click('#diglist .card-digest').catch(() => null);
      await page.waitForTimeout(350);
      const afterRows = await page.$$eval('#diglist .card', (cs) => cs.length);
      if (afterRows === beforeRows) ok(`${name} ${label}: opening one leaves it in the list (${beforeRows})`);
      else bad(`${name} ${label}: the list changed under him`, `${beforeRows} → ${afterRows}`);

      /* Reading: a newsletter renders in full inside a sandboxed frame, with a
       * text toggle. Alex, 2026-09-06.
       *
       * Reached by URL now, not by a pill. Alex, 2026-09-19: "we will remove
       * Newsletters from the mail menu, since they will be in the digest." The
       * TIER is unchanged — the reading list still assigns it, the digest
       * opens with it, the rows keep the long-read rule — so the deep link has
       * to keep working; it is what every brief and note ever written uses. */
      /* `page.goto` to the SAME path with only a different hash is a
         same-document navigation: the module never re-runs, so the view never
         changes and this quietly measured the previous one. Reload after. */
      await page.goto(base + url + '#tier=reading', { waitUntil: 'domcontentloaded' });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#diglist .card-digest', { timeout: 5000 }).catch(() => null);
      const readingCards = await page.$$('#diglist .card-digest');
      if (readingCards.length === 1) ok(`${name} ${label}: a reading deep link still lists the reading tier only`); else bad(`${name} ${label}: reading view`, String(readingCards.length));
      await page.click('#diglist .card-digest'); await page.waitForTimeout(500);
      /* The sandbox may grant same-origin — that is how the frame is measured
       * so it can be the height of the mail — but it must NEVER grant
       * allow-scripts, or the same-origin grant becomes the sender's. Pinned
       * as a property, not a literal, because the literal changed once and the
       * thing that must not change is this. */
      const sandbox = await page.$eval('#digpane iframe.read-frame', (f) => f.getAttribute('sandbox')).catch(() => null);
      if (sandbox !== null && !/allow-scripts/.test(sandbox)) ok(`${name} ${label}: the frame runs no scripts (sandbox="${sandbox}")`);
      else bad(`${name} ${label}: frame sandbox`, String(sandbox));
      /* AND A LINK IN IT WORKS. Alex, 2026-09-20: "links inside the HTML mail
         view aren't clickable. I have to right click open in new link." The
         `<base target="_blank">` was always there and always ignored — a
         sandboxed frame without allow-popups may not open a tab, so the click
         was dropped while the browser's own right-click menu, outside the
         sandbox, worked. Both halves are needed: the permission to open one,
         and for that tab not to inherit this sandbox and arrive scriptless. */
      const newTab = await page.$eval('#digpane iframe.read-frame', (f) => /<base[^>]+target="_blank"/.test(f.srcdoc || '')).catch(() => false);
      if (/allow-popups\b/.test(sandbox ?? '') && /allow-popups-to-escape-sandbox/.test(sandbox ?? '') && newTab)
        ok(`${name} ${label}: a link in the message opens in a new tab`);
      else bad(`${name} ${label}: links in the frame cannot open`, `sandbox="${sandbox}" base=${newTab}`);
      const frame = await page.$('#digpane iframe.read-frame');
      const toggle = await page.$$eval('#digpane .read-toggle .seg', (cs) => cs.map((c) => c.textContent.trim()));
      if (frame && toggle.join(',') === 'As sent,Text') ok(`${name} ${label}: the newsletter renders in a sandboxed frame with a text toggle`);
      else bad(`${name} ${label}: reading pane`, `frame=${!!frame} toggle=${toggle.join(',')}`);
      /* And the toggle is offered on ordinary mail too, defaulting to text.
       * Alex, 2026-09-19: "can we render the html?" It was gated on the
       * reading tier, which is the wrong test — what decides it is whether
       * there is an HTML twin, and whether the text part is worth reading. */
      /* Reload: coming back from `#tier=reading` to the bare path is a
         same-document navigation, so the module never re-runs and the view
         would still be the reading one. The same trap is noted above. */
      await page.goto(base + url, { waitUntil: 'domcontentloaded' });
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForSelector('#diglist .card-digest', { timeout: 5000 }).catch(() => null);
      await page.click('#diglist .card-digest'); await page.waitForTimeout(400);
      const anyToggle = await page.$$eval('#digpane .read-toggle .seg',
        (cs) => cs.map((c) => `${c.textContent.trim()}:${c.getAttribute('aria-selected')}`));
      if (anyToggle.join(',') === 'As sent:true,Text:false')
        ok(`${name} ${label}: ordinary mail opens as sent (${anyToggle.join(', ')})`);
      else bad(`${name} ${label}: toggle on ordinary mail`, anyToggle.join(',') || '(none)');
      await page.goto(base + url, { waitUntil: 'networkidle' });
    }

    if (name === 'briefs') {
      /* Unread first, and unread by default. Alex, 2026-09-18: "under briefs,
       * put unread first as the default options." This page collects every
       * brief, prep note and debrief, so within a fortnight the three he has
       * not read are somewhere down a list of forty he has. */
      /* THE LIVE-DIGEST POINTER IS GONE, 2026-09-21. Alex: "I want to
         remove the Digest summary completely from the mail section … Digests
         will be automatically archived and included in Briefs (at the
         bottom)." There is no live digest to point at any more: it is written
         just before each brief and appended to it, so the briefs page lists
         briefs and the digest is inside one. Asserted as an absence, because
         a pointer left behind would open a pane fetching a document that no
         longer exists. */
      const pointer = await page.$('#sdlist .sd-digest');
      if (!pointer) ok(`${name} ${label}: no live-digest pointer — the digest is inside the brief`);
      else bad(`${name} ${label}: the digest pointer is still on the briefs list`);
      const first = await page.$eval('#sdlist > *', (n) => n.className).catch(() => null);
      if (first && !/\bsd-digest\b/.test(first)) ok(`${name} ${label}: the list starts with a day, not a pointer`);
      else bad(`${name} ${label}: first row`, String(first));

      const chips = await page.$$eval('#sdfilters .chip', (cs) => cs.map((c) => c.firstChild?.textContent?.trim()));
      if (chips[0] === 'Unread') ok(`${name} ${label}: unread is the first chip`); else bad(`${name} ${label}: chip order`, chips.join(','));
      const picked = await page.$eval('#sdfilters .chip[aria-selected=true]', (c) => c.firstChild?.textContent?.trim()).catch(() => null);
      if (picked === 'Unread') ok(`${name} ${label}: and the page opens on it`); else bad(`${name} ${label}: default chip`, String(picked));
      const shown = await page.$$eval('#sdlist .card-msg', (cs) => cs.length);
      if (shown >= 1) ok(`${name} ${label}: the unread view is not empty (${shown})`); else bad(`${name} ${label}: opened on an empty list`);
      // Reading one must not pull it out from under him.
      await page.click('#sdlist .card-msg'); await page.waitForTimeout(250);
      const after = await page.$$eval('#sdlist .card-msg', (cs) => cs.length);
      if (after === shown) ok(`${name} ${label}: reading one leaves it in the list while he reads it`);
      else bad(`${name} ${label}: the list changed under him`, `${shown} → ${after}`);
      await page.goto(base + url, { waitUntil: 'networkidle' });
      await page.waitForTimeout(300);

      // A brief is set as writing: a lede, section eyebrows, a jump bar.
      // Alex, 2026-09-07: "I like how their briefings have more style."
      await page.click('#sdlist .card-msg:has(.card-kind-brief)'); await page.waitForTimeout(250);
      const lede = await page.$('#sdpane .brief-body .lede');
      const secs = await page.$$('#sdpane .brief-body .brief-sec');
      const byl = await page.$eval('#sdpane .brief-byline', (n) => n.textContent).catch(() => '');
      if (lede && secs.length >= 1) ok(`${name} ${label}: the brief has a lede and ${secs.length} section head(s)`); else bad(`${name} ${label}: brief layout`, `lede=${!!lede} secs=${secs.length}`);
      if (/^(Brief|Note|Meeting prep|Debrief)\s+·/.test(byl)) ok(`${name} ${label}: the byline names the kind and the day`); else bad(`${name} ${label}: byline`, byl);
      const measured = await page.$eval('#sdpane .brief-body', (n) => getComputedStyle(n).maxWidth);
      if (measured && measured !== 'none') ok(`${name} ${label}: the brief is set to a readable measure (${measured})`); else bad(`${name} ${label}: no measure cap`);
    }

    if (false) {
      const kinds = await page.$$eval('#sdlist .card-msg .card-kind', (els) => els.map((e) => e.textContent.trim()));
      if (kinds.length && !kinds.includes('reminder') && !kinds.includes('failure')) ok(`${name} ${label}: default view carries no reminder or failure records (${[...new Set(kinds)].join(', ')})`);
      else bad(`${name} ${label}: kinds on the default view`, kinds.join(', ') || '(none)');
      const chipText = await page.$$eval('#sdfilters .chip', (cs) => cs.map((c) => c.firstChild?.textContent?.trim()));
      if (!chipText.includes('reminder') && !chipText.includes('failure')) ok(`${name} ${label}: no reminder or failure chips`); else bad(`${name} ${label}: chips`, chipText.join(','));
      const unreadChip = await page.$eval('#sdfilters .chip:nth-of-type(2) b', (b) => Number(b.textContent)).catch(() => -1);
      await page.click('#sdfilters .chip:nth-of-type(2)'); await page.waitForTimeout(100);
      const unreadRows = await page.$$('#sdlist .card-msg');
      if (unreadChip === unreadRows.length) ok(`${name} ${label}: the unread pill and the unread list agree (${unreadChip})`); else bad(`${name} ${label}: unread pill vs list`, `${unreadChip} vs ${unreadRows.length}`);
      await page.click('#sdfilters .chip:nth-of-type(1)'); await page.waitForTimeout(100);
      const sel = '#sdlist .card-msg';
      await page.waitForSelector(sel, { timeout: 3000 }).catch(() => null);
      await page.click(sel).catch(() => null);
      await page.waitForTimeout(300);
      const body = await page.$('#sdpane .body');
      if (body) ok(`${name} ${label}: selecting a row fills the pane with the message`);
      else bad(`${name} ${label}: no rendered message in the pane after selecting a row`);
    }

    if (name === 'system') {
      const rows = await page.$$('.sched-row');
      if (rows.length >= 3) ok(`${name} ${label}: the schedule is rows, not a log dump (${rows.length})`);
      else bad(`${name} ${label}: expected schedule rows, got ${rows.length}`);
      const jobs = await page.$$('details.job');
      if (jobs.length >= 1) ok(`${name} ${label}: job output is present in full behind a summary (${jobs.length})`);
      else bad(`${name} ${label}: no job output details found`);
      const acts = await page.$$('.act-row');
      if (acts.length >= 1) ok(`${name} ${label}: recent activity is rows (${acts.length})`);
      else bad(`${name} ${label}: no activity rows`);
    }

    if (name === 'todo') {
      /* The Outbox, merged in. Alex, 2026-09-19: "Lets merge the outbox into
       * To Do. It should be more of a filter, here are the To Do's with items
       * Drafted so you can see which task the entry is for." A draft is an
       * attribute of the debt it discharges — and the ones that join no task
       * still have to be somewhere, or the merge loses half a queue.
       *
       * The pane assertions came from the Outbox page, which this replaced:
       * the thread runs down it oldest-first and the unsent reply sits at the
       * foot with Send and Discard under it. */
      await page.goto(base + url, { waitUntil: 'networkidle' });
      await page.waitForTimeout(300);
      await page.click('#filt button[data-f=drafted]');
      await page.waitForTimeout(500);
      const marked = await page.$$eval('#tasklist .ob-draft', (ns) => ns.map((n) => n.textContent));
      if (marked.length >= 1) ok(`${name} ${label}: a task with a reply ready says so on its row (${marked.join(', ')})`);
      else bad(`${name} ${label}: no draft marker in the drafted bucket`);
      // The fixture's mail draft is on thread a1b2c3d4, which the SaunaCo
      // obligation is evidenced by; the text goes to a chat no task carries.
      const rows = await page.$$eval('#tasklist .ob .ob-title', (ns) => ns.map((n) => n.textContent));
      if (rows.length >= 2) ok(`${name} ${label}: the joined task and the loose draft are both listed (${rows.length})`);
      else bad(`${name} ${label}: drafted rows`, rows.join(' | '));
      await page.click('#tasklist .ob .ob-inner');
      await page.waitForTimeout(700);
      const order = await page.$eval('#taskpane', (n) => [...n.querySelectorAll('.out-msg, .out-draft')]
        .map((x) => (x.classList.contains('out-draft') ? 'draft' : 'msg')).join(','));
      if (/draft$/.test(order)) ok(`${name} ${label}: the reply sits at the foot of the thread (${order})`);
      else bad(`${name} ${label}: draft is not at the foot`, order || '(nothing)');
      const acts = await page.$$eval('#taskpane .out-actions button', (bs) => bs.map((b) => b.textContent.trim()));
      if (acts.some((t) => /^Send to /.test(t)) && acts.includes('Discard'))
        ok(`${name} ${label}: Send and Discard sit under it (${acts.join(', ')})`);
      else bad(`${name} ${label}: draft actions`, acts.join(' | ') || '(none)');

      /* Add tag: existing first, create last. Alex, 2026-09-30: "the add
         tag option, should first match existing tags, then offer to create
         one if no match." */
      await page.fill('#taskpane .tagin', 'on');
      await page.waitForTimeout(150);
      const sug = await page.$$eval('#taskpane .tagsug-row', (ns) => ns.map((n) => n.textContent));
      if (sug.some((t) => /^#one/.test(t)) && !sug.some((t) => /^Create #on$/.test(t))) ok(`${name} ${label}: typing a tag suggests the existing one first (${sug[0]})`);
      else bad(`${name} ${label}: tag suggestions`, sug.join(' | ') || '(none)');
      await page.fill('#taskpane .tagin', 'zzqx');
      await page.waitForTimeout(150);
      const sug2 = await page.$$eval('#taskpane .tagsug-row', (ns) => ns.map((n) => n.textContent));
      if (sug2.length === 1 && sug2[0] === 'Create #zzqx') ok(`${name} ${label}: no match offers to create it`);
      else bad(`${name} ${label}: create offer`, sug2.join(' | ') || '(none)');
      await page.fill('#taskpane .tagin', '');

      /* Close: options with radios. Alex, 2026-09-30: "make it three
         seperate fields with a radio box. option 1, option 2, and then fully
         blank one." The fixture's task closes on one thing, so: it, and blank. */
      await page.click('#taskpane .ob-close-top');
      await page.waitForTimeout(200);
      const opts = await page.$$eval('#taskpane .outcome-opt', (ns) => ns.map((n) => ({ on: n.querySelector('input[type=radio]').checked, v: n.querySelector('input[type=text]').value })));
      if (opts.length >= 2 && opts[0].on && opts[0].v && opts[opts.length - 1].v === '') ok(`${name} ${label}: closing offers what closes it as an option, and a blank one (${opts.length})`);
      else bad(`${name} ${label}: close options`, JSON.stringify(opts));
      await page.click('#taskpane .outcomebox button.ghost:has-text("Cancel")');
      await page.waitForTimeout(150);
      const swipe = await page.$('#tasklist .swipe');
      if (!swipe) ok(`${name} ${label}: nothing here swipes — a send is a button, not a gesture`);
      else bad(`${name} ${label}: a swipeable row in the drafted bucket`);
      await page.screenshot({ path: `${SHOTS}/todo-drafted-${label}.png`, fullPage: true });

      /* THE MAP, beside the list. Alex, 2026-09-30: projects as circles, a
         tap lists the circle's tasks in the sidebar ("in map mode, lets keep
         the sidebar column"), circles drag anywhere, right-click adds one, and
         a task dragged onto a circle moves there. Saves are caught, not sent. */
      const saved = [], tagged = [];
      await page.route('**/api/todo/map-layout', async (route) => {
        if (route.request().method() === 'POST') saved.push(JSON.parse(route.request().postData() || '{}'));
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, positions: {} }) });
      });
      await page.route('**/api/obligations/tags', async (route) => {
        const b = JSON.parse(route.request().postData() || '{}');
        tagged.push(b);
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, id: b.id, tags: b.tags }) });
      });
      await page.click('#filt button[data-f=map]');
      await page.waitForTimeout(400);
      const circles = await page.$$eval('#taskpane .tmap-c', (ns) => ns.map((n) => n.getAttribute('aria-label')));
      if (circles.length >= 2) ok(`${name} ${label}: the map draws a circle per project, in the pane (${circles.length})`);
      else bad(`${name} ${label}: map circles`, circles.join(' | ') || '(none)');
      await page.screenshot({ path: `${SHOTS}/todo-map-${label}.png`, fullPage: true });
      const firstLabel = circles[0] ?? '';
      const said = Number((firstLabel.match(/: (\d+) task/) ?? [])[1]);
      await page.click('#taskpane .tmap-c');
      await page.waitForTimeout(400);
      const crumb = await page.$eval('#tasklist .map-crumb', (n) => n.textContent).catch(() => '');
      const opened = await page.$$eval('#tasklist .ob', (ns) => ns.length);
      if (!/‹ map/.test(crumb) && opened >= 1 && opened === said) ok(`${name} ${label}: a circle fills the sidebar with its tasks — as many as it said (${opened}), no ‹ map link`);
      else bad(`${name} ${label}: circle did not fill the list`, `${crumb} / ${opened} rows, said ${said}`);
      if (label === 'desktop') {
        const both = await page.evaluate(() => [document.querySelector('#tasklist'), document.querySelector('#taskpane .tmap')].every((n) => n && n.getBoundingClientRect().width > 0));
        if (both) ok(`${name} ${label}: the sidebar stays beside the map`);
        else bad(`${name} ${label}: sidebar or map not showing together`);
        const target = await page.$$eval('#taskpane .tmap-c', (ns) => ns.findIndex((n) => /tmap-project/.test(n.getAttribute('class')) && !/tmap-picked/.test(n.getAttribute('class'))));
        if (target >= 0) {
          await page.dragAndDrop('#tasklist .ob-draggable', `#taskpane .tmap-c >> nth=${target}`);
          await page.waitForTimeout(300);
          const moved = tagged.find((b) => b.id && Array.isArray(b.tags));
          if (moved && moved.tags.length >= 1) ok(`${name} ${label}: a task dropped on a circle is moved there (${JSON.stringify(moved.tags)})`);
          else bad(`${name} ${label}: drop onto a circle`, JSON.stringify(tagged));
        } else bad(`${name} ${label}: no second project circle to drop onto`);
      }
      /* + new To Do. Alex, 2026-09-30: "add a +new To Do button, and when you
         click on it you get a blank entry in the left column, styled like a
         card, but you can enter a manual to-do." */
      const posted = [];
      await page.route('**/api/todo', async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        posted.push(JSON.parse(route.request().postData() || '{}'));
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, section: 'Now', tag: null }) });
      });
      await page.click('#tasklist .map-new');
      await page.waitForTimeout(200);
      const card = await page.$('#tasklist .ob-new textarea');
      if (card) {
        await card.fill('Call the elevator inspector');
        await page.click('#tasklist .ob-new button[type=submit]');
        await page.waitForTimeout(400);
      }
      if (card && posted.some((b) => b.text === 'Call the elevator inspector')) ok(`${name} ${label}: + new To Do opens a card in the list and files what is typed`);
      else bad(`${name} ${label}: + new To Do`, `card ${!!card}, posted ${JSON.stringify(posted)}`);
      await page.unroute('**/api/todo');
      // Back to the whole map: the picked circle tapped again on a desk; on a
      // phone, where the list hides the map, the Map tab.
      if (label === 'desktop') await page.click('#taskpane .tmap-c.tmap-picked');
      else await page.click('#filt button[data-f=map]');
      await page.waitForTimeout(400);
      const unpicked = await page.$$eval('#taskpane .tmap-c.tmap-picked', (ns) => ns.length);
      if (!unpicked) ok(`${name} ${label}: tapping the picked circle again lets go of it`);
      else bad(`${name} ${label}: picked circle stayed picked`);
      const g = await page.$('#taskpane .tmap-c');
      const box = await g.boundingBox();
      const before = await g.getAttribute('transform');
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 30, { steps: 6 });
      await page.mouse.up();
      await page.waitForTimeout(300);
      const after = await g.getAttribute('transform').catch(() => null);
      const stillMap = await page.$('#taskpane .tmap');
      if (after && after !== before && stillMap && saved.some((b) => b.key && Number.isFinite(b.x)))
        ok(`${name} ${label}: a circle drags to a new spot, is saved, and a drag is not a tap`);
      else bad(`${name} ${label}: drag`, `${before} → ${after}; map ${!!stillMap}; saved ${JSON.stringify(saved)}`);
      const svgBox = await (await page.$('#taskpane .tmap')).boundingBox();
      await page.mouse.click(svgBox.x + 4, svgBox.y + 4, { button: 'right' });
      await page.waitForTimeout(200);
      const form = await page.$('#taskpane .map-add input');
      if (form) ok(`${name} ${label}: right-click on empty space asks for a new project`);
      else bad(`${name} ${label}: no add form on right-click`);
      await page.unroute('**/api/todo/map-layout');
      await page.unroute('**/api/obligations/tags');

      await page.goto(base + url, { waitUntil: 'networkidle' });
      await page.waitForTimeout(300);
    }

    if (name === 'today') {
      // The top section is Briefs, and a failure is System's, not Today's.
      // Alex, 2026-09-07.
      const heads = await page.$$eval('#today .sec-title', (hs) => hs.map((h) => h.textContent));
      if (heads.some((h) => /^briefs/.test(h)) && !heads.some((h) => /said to you/.test(h))) ok(`${name} ${label}: the top section is briefs`); else bad(`${name} ${label}: sections`, heads.join('|'));
      const kinds = await page.$$eval('#today .card-msg .card-kind', (ks) => ks.map((k) => k.textContent.trim()));
      if (!kinds.includes('failure')) ok(`${name} ${label}: no system alerts among the briefs`); else bad(`${name} ${label}: a failure on Today`, kinds.join(','));
      // The page keeps the last payload and paints it before fetching. Alex,
      // 2026-09-06: "never see Assembling on load."
      const kept = await page.evaluate(() => { try { return !!localStorage.getItem('obligations.today'); } catch { return false; } });
      if (kept) ok(`${name} ${label}: the last payload is kept for the next open`); else bad(`${name} ${label}: nothing remembered`);
      await page.reload({ waitUntil: 'domcontentloaded' });
      const early = await page.$eval('#today', (n) => n.textContent.includes('assembling'));
      if (!early) ok(`${name} ${label}: a reload paints content, not "assembling…"`); else bad(`${name} ${label}: reload showed assembling`);
      await page.waitForLoadState('networkidle');
    }

    if (name === 'system') {
      const h = await page.$$eval('h2', (hs) => hs.map((x) => x.textContent));
      if (h[0] === 'failures') ok(`${name} ${label}: failures are the first section on System`); else bad(`${name} ${label}: sections`, h.join('|'));
    }

    if (name === 'todo') {
      // Every card on Today links here as /todo#pane=<id>. Alex, 2026-09-06:
      // "clicking on most items on today doesn't actually take you to the item
      // clicked on." The fixture task is owed by them, so it also has to
      // switch buckets away from the default.
      // A hash-only change on the page already open is a same-document
      // navigation and re-runs nothing; leave and come back, the way a tap on
      // Today arrives.
      await page.goto(base + '/system', { waitUntil: 'networkidle' });
      await page.goto(base + url + '#pane=' + encodeURIComponent('todo:dd44ee55ff66'), { waitUntil: 'networkidle' });
      await page.waitForTimeout(500);
      const obWeight = await page.$eval('#tasklist .ob-row .ob-who', (n) => getComputedStyle(n).fontWeight).catch(() => null);
      if (obWeight && Number(obWeight) < 600) ok(`${name} ${label}: a task row has no read state, so no bold`); else bad(`${name} ${label}: task row weight`, String(obWeight));
      const showing = await page.$eval('#split', (n) => n.classList.contains('showing'));
      const open = await page.$eval('#taskpane', (n) => n.textContent.trim().slice(0, 60));
      if (showing && open && !/Select a task/.test(open)) ok(`${name} ${label}: arriving with #pane opens that task (${open.slice(0, 30)}…)`);
      else bad(`${name} ${label}: #pane on arrival`, `showing=${showing} pane="${open}"`);
      // A reminder's pane carries its due date, editable. Alex, 2026-09-06.
      await page.goto(base + '/system', { waitUntil: 'networkidle' });
      await page.goto(base + url + '#pane=' + encodeURIComponent('rem:c0de'), { waitUntil: 'networkidle' });
      await page.waitForTimeout(400);
      // The action center: Close, Move due (when there is a date), Ask the assistant.
      const labels = await page.$$eval('#taskpane .ob-actions button', (bs) => bs.map((b) => b.textContent));
      if (labels.join(',') === 'Close,Move due,Ask the assistant') ok(`${name} ${label}: the action center on a dated task`); else bad(`${name} ${label}: actions`, labels.join(','));
      await page.click('#taskpane .ob-actions .ob-move'); await page.waitForTimeout(100);
      const due = await page.$('#taskpane .due-edit input[type="datetime-local"]');
      if (due) ok(`${name} ${label}: a reminder's due date is editable, with its time`); else bad(`${name} ${label}: no due-date control on a reminder`);
      await page.click('#taskpane .ob-actions .ob-done'); await page.waitForTimeout(100);
      const outcome = await page.$$eval('#taskpane .outcomebox button', (bs) => bs.map((b) => b.textContent));
      const prefilled = await page.$eval('#taskpane .outcomebox input', (n) => n.value).catch(() => '');
      // "Not a task" (2026-09-20): the fourth choice, which turns the note into
      // a verdict the triage reads. Cancel stays last so the click below finds it.
      if (outcome.join(',') === 'Record,No note,Not a task,Cancel' && prefilled !== null) ok(`${name} ${label}: close asks for a note (prefilled when the task says what closes it), none, or "not a task"`); else bad(`${name} ${label}: close box`, `${outcome.join(',')} | "${prefilled}"`);
      // Closing is a mode: while the note box is open the action row is hidden,
      // so there is one decision on screen instead of two rows of buttons at
      // different heights. Alex, 2026-09-08: "very unbalanced." Cancel puts
      // it back, and that restoration is worth asserting — a mode you cannot
      // leave is worse than the layout it replaced.
      const hidden = await page.$eval('#taskpane .ob-actions', (n) => getComputedStyle(n).display);
      if (hidden === 'none') ok(`${name} ${label}: the action row steps aside while a close is being written`);
      else bad(`${name} ${label}: actions still showing behind the close box`, hidden);
      await page.click('#taskpane .outcomebox button.ghost:last-of-type'); await page.waitForTimeout(100);
      const back = await page.$eval('#taskpane .ob-actions', (n) => getComputedStyle(n).display);
      if (back !== 'none') ok(`${name} ${label}: and comes back when the close is cancelled`);
      else bad(`${name} ${label}: cancel left the actions hidden`, back);
      await page.click('#taskpane .ob-actions .ob-ask'); await page.waitForTimeout(100);
      const asked = await page.$eval('#workdock .composer-input', (n) => n.value).catch(() => '');
      if (/^About "/.test(asked)) ok(`${name} ${label}: ask the assistant hands the task to the composer`); else bad(`${name} ${label}: ask`, asked);

      // THE CLOSED VIEW. Alex's review, 2026-09-20: a closed item had no page.
      await page.click('#filt button[data-f=closed]'); await page.waitForTimeout(400);
      const closedRows = await page.$$eval('#tasklist .ob.closed', (ns) => ns.map((n) => n.querySelector('.ob-preview')?.textContent ?? ''));
      if (closedRows.length === 2 && /by agent:review/.test(closedRows[0])) ok(`${name} ${label}: the closed chip lists what closed, newest first, with who and on what`); else bad(`${name} ${label}: closed list`, JSON.stringify(closedRows));
      await page.click('#tasklist .ob.closed .ob-title'); await page.waitForTimeout(200);
      const closedLine = await page.$eval('#taskpane .ob-closed-line', (n) => n.textContent).catch(() => '');
      const reopenBtn = await page.$('#taskpane .ob-reopen');
      if (/closed 2026-08-28 15:10 by agent:review — closes_when met/.test(closedLine) && reopenBtn) ok(`${name} ${label}: the pane says who closed it and on what, and offers Reopen`); else bad(`${name} ${label}: closed pane`, closedLine);
      await page.click('#taskpane .ob-reopen'); await page.waitForTimeout(100);
      const askWhy = await page.$eval('#taskpane .outcomebox input', (n) => n.placeholder).catch(() => '');
      if (/Why is this open again/.test(askWhy)) ok(`${name} ${label}: reopen asks for a reason`); else bad(`${name} ${label}: reopen prompt`, askWhy);
      const noSwipeClose = await page.$$eval('#tasklist .ob.closed .ob-done', (ns) => ns.length);
      if (noSwipeClose === 0) ok(`${name} ${label}: nothing on a closed row invites closing it again`); else bad(`${name} ${label}: closed row actions`, String(noSwipeClose));

      // Grouped by project, and adding one by hand. Alex, 2026-09-16.
      await page.goto(base + url, { waitUntil: 'networkidle' });
      await page.waitForTimeout(300);
      await page.click('#filt button[data-f=projects]');
      await page.waitForTimeout(300);
      const heads = await page.$$eval('#tasklist .sec-head .sec-title', (hs) => hs.map((h) => h.textContent));
      // Heads are project names since 2026-10-04 (PHOA CRM, ONE 2201/2202), the tag beside.
      if (heads.some((h) => /^PHOA CRM · \d/.test(h)) && heads.some((h) => /^ONE 2201\/2202 · \d/.test(h)))
        ok(`${name} ${label}: by project groups under one head per project (${heads.join(', ')})`);
      else bad(`${name} ${label}: project heads`, heads.join('|'));
      // What no project claims is hidden (Alex, 2026-10-04) — and counted,
      // with the way to it, on the last line.
      const looseLine = await page.$eval('#tasklist .proj-loose', (n) => n.textContent).catch(() => '');
      if (!heads.some((h) => /^no project/.test(h)) && /^\d+ on no project/.test(looseLine)) ok(`${name} ${label}: no-project tasks are hidden but counted (${looseLine})`);
      else bad(`${name} ${label}: no-project line`, `${heads.join('|')} / ${looseLine}`);
      const projCount = await page.$eval('#n-projects', (n) => n.textContent);
      if (Number(projCount) > 0) ok(`${name} ${label}: the chip counts what is on a project (${projCount})`);
      else bad(`${name} ${label}: projects chip count`, projCount);

      // One way to add (2026-10-04): + new To Do at the head of the list.
      await page.click('#tasklist .list-new .map-new');
      await page.waitForTimeout(200);
      const picker = await page.$$eval('#tasklist .ob-new select[aria-label=Project] option', (os) => os.map((o) => o.value));
      if (picker.includes('phoa') && picker.includes('one'))
        ok(`${name} ${label}: + new To Do opens a card with every project in its picker`);
      else bad(`${name} ${label}: new to-do card`, `options=${picker.join(',')}`);
      await page.click('#tasklist .ob-new button.ghost');
      /* The shareable code. Alex, 2026-09-19: "can you add a unique id (like
         the reminders have) so I can easily share with you." — and 2026-09-21,
         "can we move the ID numbers on to-do from the sidebar to the main
         area": it is in the PANE now, not on every row. Both halves are
         asserted, because the row losing it is the change and the pane having
         it is the point; a version with it in neither place would otherwise
         pass. */
      const rowCodes = await page.$$eval('#tasklist .ob-code', (cs) => cs.map((c) => c.textContent.trim()));
      if (!rowCodes.length) ok(`${name} ${label}: the index rows carry no code — it moved to the pane`);
      else bad(`${name} ${label}: the code is still on the row`, rowCodes.join(','));

      /* AND IT IS IN THE PANE. Both halves, or moving it to nowhere passes.
         Open a task first: this block has been filtering the list, so nothing
         is selected by the time it gets here. */
      await page.goto(base + '/system', { waitUntil: 'networkidle' });
      await page.goto(base + url + '#pane=' + encodeURIComponent('mail:personal:t1'), { waitUntil: 'networkidle' });
      await page.waitForTimeout(500);
      const paneCode = await page.$eval('#taskpane .ob-code', (n) => n.textContent.trim()).catch(() => null);
      if (paneCode) ok(`${name} ${label}: the open task shows its code in the pane (${paneCode})`);
      else bad(`${name} ${label}: no code in the pane after opening a task`);

      /* TEXT OR AS SENT, on a task's mail too. Alex, 2026-09-21: "when
         to-dos link to messages, lets offer both HTML and Text view." */
      const evrow = await page.$('#taskpane .ob-ev .ob-evrow');
      if (evrow) { await evrow.click(); await page.waitForTimeout(400); }
      const segs = await page.$$eval('#taskpane .read-toggle .seg', (bs) => bs.map((b) => b.textContent.trim()));
      if (segs.includes('As sent') && segs.includes('Text')) ok(`${name} ${label}: a mail task offers both views`);
      else bad(`${name} ${label}: no Text/As-sent switch on a mail task`, segs.join(','));

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow <= 1) ok(`${name} ${label}: the add form does not push the page sideways`);
      else bad(`${name} ${label}: add form overflows by ${overflow}px`);
      await page.goto(base + url, { waitUntil: 'networkidle' });
    }

    if (name === 'mail') {
      // Mail only, unread first, by date or by sender. Alex, 2026-09-06.
      // Three views, three scopes. Alex, 2026-09-19: "lets combine digest and
      // unread on the mail tab" and "i don't understand all 738 vs filed 2017".
      // Two views and two lenses. Alex, 2026-09-19: "reading should be a
      // filter inside unread, and it needs a better description."
      /* Named for what it selects, not for a recommendation it does not make.
       * Alex, 2026-09-19: "where is worth opening coming from? None of these
       * are really that important." The tier is the 55 senders his own filters
       * forward to newsletters@ — provenance, and rules/email-triage.md says
       * "Nothing is ever 'recommended'; it is a list, not a feed." */
      /* One row, three groups, every place mail can be. Alex, 2026-09-19:
       * "lets put the pills from archive on the same level as unread." The
       * seven archive tiers used to live on a second row that only existed
       * once the archive was open. */
      const groups = await page.$$eval('#digfilters .filt-group', (gs) => gs.map((g) => g.textContent.trim()));
      /* Only the archive keeps a group name. Alex, 2026-09-19, sketching the
       * row: "Unread 1232, Unread Newsletters 65, Pending 0 Archived: Action".
       * The first three pills say what they are on their own; "Action" and
       * "Digest" mean nothing without a word over them. */
      /* NO TOGGLE AT ALL, 2026-09-21. Alex: "Remove the Unread Only
         toggle." It was a second definition of what the digest held, and the
         Archive button used the other one — which is why their numbers kept
         disagreeing. Asserted as an absence, so it cannot come back quietly. */
      const sw = await page.$('#digfilters .toggle');
      if (!sw) ok(`${name} ${label}: no unread-only toggle — membership is the bucket`);
      else bad(`${name} ${label}: the unread toggle is still on the filter row`);
      if (!groups.length) ok(`${name} ${label}: no group names left to read`);
      else bad(`${name} ${label}: filter groups`, groups.join(','));
      const pills = await page.$$eval('#digfilters .chip', (cs) => cs.map((c) => (c.firstChild?.textContent ?? '').trim()));
      if (pills.every((t) => !t || t[0] === t[0].toUpperCase())) ok(`${name} ${label}: every pill is capitalised`);
      else bad(`${name} ${label}: lower-case pills`, pills.filter((t) => t && t[0] !== t[0].toUpperCase()).join(', '));
      /* HIS ORDER, verbatim. Alex, 2026-09-19: "on mail page show Digest,
       * Newsletter, Action, Memory, Awareness, Ephemeral, Silent, All." The two
       * he reads lead; All closes the row rather than opening it, because it is
       * the fallback and not a category beside the other seven. `reading` is
       * the internal name for Newsletter, and `pending` is not a tier at all —
       * it is mail nothing has judged — so it sits last of all. */
      const views = await page.$$eval('#digfilters .chip[data-view]', (cs) => cs.map((c) => c.dataset.view));
      /* The digest split in two on 2026-09-21: `current` is what the next
         brief will report, `never` is everything judged before the assistant kept
         a record of what it had reported. They lead, for the same reason
         Digest used to. */
      const wantViews = 'current,action,memory,awareness,ephemeral,silent,all,pending';
      if (views.join(',') === wantViews) ok(`${name} ${label}: the pills are in his order, no newsletters, All last, then pending`);
      else bad(`${name} ${label}: views`, views.join(','));
      /* THE URL IS THE VIEW. Alex, 2026-09-19: "can we write the url on
       * every load, so you can deeplink to a mail, task etc." Picking a tier
       * writes it; opening a message adds the pane beside it; and arriving at
       * that URL cold lands on the same thing. */
      await tap('action');
      const afterTier = await page.evaluate(() => location.hash);
      if (/tier=action/.test(afterTier)) ok(`${name} ${label}: the tier is in the URL (${afterTier})`);
      else bad(`${name} ${label}: tier not in the URL`, afterTier || '(empty)');
      await page.click('#diglist .card-digest'); await page.waitForTimeout(400);
      const withPane = await page.evaluate(() => location.hash);
      if (/tier=action/.test(withPane) && /pane=/.test(withPane)) ok(`${name} ${label}: and the open message joins it (${withPane})`);
      else bad(`${name} ${label}: pane and tier together`, withPane || '(empty)');
      /* Cold, from the link alone. `domcontentloaded` rather than
       * `networkidle`: a message opens as sent now, so the pane holds a
       * `srcdoc` iframe, and Playwright does not count that frame as settling
       * — the page is idle, the wait is not. Waiting on the thing we are
       * about to assert is the more honest wait anyway. */
      await page.goto(base + url + withPane, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#digpane .pane-title', { timeout: 10000 }).catch(() => null);
      await page.waitForTimeout(400);
      const landed = await page.evaluate(() => ({
        tier: document.querySelector('#digfilters .chip[data-view=action][aria-selected=true]') ? 'action' : null,
        pane: document.querySelector('#digpane .pane-title')?.textContent?.trim() ?? '',
      }));
      if (landed.tier === 'action' && landed.pane) ok(`${name} ${label}: the link lands on both (${landed.pane.slice(0, 32)}…)`);
      else bad(`${name} ${label}: deep link`, JSON.stringify(landed));
      await page.goto(base + url, { waitUntil: 'networkidle' });
      await page.waitForTimeout(300);
      /* THE PILLS MOVE AS HE READS. Alex, 2026-09-19: "can you update the
       * unread counters in the menu in realtime as items are read." They did
       * not: the list is drawn from `items` and re-rendered on every change,
       * the pills from the server's tally, which only arrives with a load. So
       * clearing a section emptied the list and left every number as it was. */
      /* READING SOMETHING DOES NOT TAKE IT OUT OF THE DIGEST, 2026-09-21.
         Alex: "You can still track read/unread status, but they will always
         be in the current digest until that Digest is archived." So the
         Current pill must hold still while he reads — it is the size of what
         the next brief will report, which is also what the Archive button
         says, and those two numbers disagreeing is the bug this replaced.
         All holds still for the older reason: it is the whole archive. */
      const countOf = (v) => page.$eval(`#digfilters .chip[data-view=${v}] b`, (b) => Number(b.textContent)).catch(() => -1);
      const before = await countOf('current');
      const allBefore = await countOf('all');
      const marks = await page.$$eval('#diglist .dg-foot .dg-mark', (bs) => bs.map((b) => b.textContent.trim()));
      await page.evaluate(() => document.querySelector('#diglist .dg-foot .dg-mark')?.click());
      await page.waitForTimeout(600);
      const after = await countOf('current');
      const allAfter = await countOf('all');
      if (before > 0 && after === before) ok(`${name} ${label}: reading leaves it in the current digest (${after})`);
      else bad(`${name} ${label}: the current pill moved when something was read`, `${before} → ${after}; buttons: ${marks.join(' | ') || '(none)'}`);
      if (allBefore > 0 && allAfter === allBefore) ok(`${name} ${label}: and All holds the whole archive throughout (${allAfter})`);
      else bad(`${name} ${label}: All moved when something was read`, `${allBefore} → ${allAfter}`);
      /* And the row itself says it was read — the state is still tracked, it
         just no longer decides anything. */
      const readRows = await page.$$eval('#diglist .card-digest.read', (cs) => cs.length);
      if (readRows > 0) ok(`${name} ${label}: the row is marked read (${readRows})`);
      else bad(`${name} ${label}: nothing rendered as read after marking`);
      await page.goto(base + url, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#digfilters .chip', { timeout: 10000 }).catch(() => null);
      await page.waitForTimeout(400);

      /* NEVER DIGESTED HAS NO PILL, 2026-09-22. Alex: "i would just hide that
         area, it doesnt add much value." Asserted as an absence — and the
         deep link still works, because hiding a pile is not deleting it. */
      const neverPill = await page.$('#digfilters .chip[data-view=never]');
      if (!neverPill) ok(`${name} ${label}: no Never digested pill`);
      else bad(`${name} ${label}: the Never digested pill is still on the row`);
      await page.goto(base + url + '#tier=never', { waitUntil: 'domcontentloaded' });
      await page.reload({ waitUntil: 'networkidle' });
      const neverRows = await page.$$eval('#diglist .card-digest', (cs) => cs.length);
      if (neverRows === 1) ok(`${name} ${label}: #tier=never still lists them for anyone who looks (${neverRows})`);
      else bad(`${name} ${label}: never-digested deep link`, `${neverRows} rows`);
      await page.goto(base + url, { waitUntil: 'domcontentloaded' });
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForSelector('#digfilters .chip', { timeout: 10000 }).catch(() => null);
      /* BY DATE AND BY SENDER ARE THE SAME THING, GROUPED DIFFERENTLY.
       *
       * Alex, 2026-09-19: "by Date and by Sender should share design and
       * functionality." They had drifted into two grammars — by date drew
       * cards under a section head, by sender drew a bespoke roll-up of
       * one-line rows folded three deep, and only one of them could mark a
       * group read. One shape now, and the proof is that the same selectors
       * find the same furniture under either grouping. */
      const shape = async () => page.evaluate(() => ({
        heads: [...document.querySelectorAll('#diglist .sec-title')].map((h) => h.textContent.trim()),
        rows: document.querySelectorAll('#diglist .card-digest').length,
        marks: [...document.querySelectorAll('#diglist .dg-foot:not(.dg-foot-all) .dg-mark')].map((b) => b.textContent.trim()),
        all: document.querySelector('#diglist .dg-foot-all .dg-mark')?.textContent.trim() ?? '',
      }));
      const byDate = await shape();
      await tap('By sender');
      const bySender = await shape();
      await tap('By date');
      if (byDate.rows === bySender.rows && byDate.rows >= 2)
        ok(`${name} ${label}: both groupings draw the same rows (${byDate.rows})`);
      else bad(`${name} ${label}: rows differ between groupings`, `${byDate.rows} vs ${bySender.rows}`);
      if (byDate.heads.length && bySender.heads.length)
        ok(`${name} ${label}: both group under section heads (${byDate.heads.length} by date, ${bySender.heads.length} by sender)`);
      else bad(`${name} ${label}: section heads`, `${byDate.heads.join('|')} / ${bySender.heads.join('|')}`);
      /* And the mark-read sits at the FOOT of each section under both.
       * "put the mark 42 read at the bottom of each section, not the top." */
      if (byDate.marks.length && bySender.marks.length
          && byDate.marks.every((m) => /^Mark \d+ read$/.test(m))
          && bySender.marks.every((m) => /^Mark \d+ read$/.test(m)))
        ok(`${name} ${label}: each section marks itself read from its foot (${byDate.marks.join(', ')})`);
      else bad(`${name} ${label}: mark-read footers`, `${byDate.marks.join('|')} / ${bySender.marks.join('|')}`);
      /* And ONE MORE at the very bottom that clears the whole list. Alex,
       * 2026-09-19: "at the bottom of each list, put a Mark all X Read."
       *
       * What is checked is the NUMBER, because that is the half that can go
       * wrong quietly: the same button on the digest pane once read "mark 1233
       * read" over a digest of 294, taking the backlog with it. It must equal
       * the sections' own numbers added up — the list in front of him, under
       * either grouping, and nothing outside it. */
      const sum = (ms) => ms.reduce((n, m) => n + Number(/\d+/.exec(m)?.[0] ?? 0), 0);
      const allOf = (s) => Number(/[\d,]+/.exec(s)?.[0].replace(/,/g, '') ?? NaN);
      /* The mark-all foot is drawn only where there is more than one section:
         with one, its own foot already says that number and a second button
         under it would offer the same tap twice with two different labels. The
         current bucket is one section in the fixture, so what is asserted is
         that the numbers agree when it IS drawn, and that it is absent when it
         is not. */
      const footAgrees = (g) => (g.all ? allOf(g.all) === sum(g.marks) : g.marks.length <= 1);
      if (footAgrees(byDate) && footAgrees(bySender))
        ok(`${name} ${label}: the list foot clears exactly what is listed${byDate.all ? ` (${byDate.all})` : ', and is absent under a single section'}`);
      else bad(`${name} ${label}: mark-all foot`, `${byDate.all} over ${byDate.marks.join('|')} / ${bySender.all} over ${bySender.marks.join('|')}`);
      /* THE WRITTEN DIGEST IS NOT ON THIS PAGE ANY MORE, 2026-09-21. Alex:
         "I want to remove the Digest summary completely from the mail
         section." No summary card in the list, no prose pane beside it — the
         document is written just before each brief and appended to it, so
         Mail is the index and Briefs is the reading. Asserted as absences,
         because half a removal is what leaves a button pointing at a document
         that no longer exists. */
      const leftovers = await page.evaluate(() => ({
        card: !!document.querySelector('#diglist .card-prose'),
        pane: !!document.querySelector('#digpane .brief-body'),
        summary: !!document.querySelector('#diglist .card-prose .card-title'),
      }));
      if (!leftovers.card && !leftovers.summary) ok(`${name} ${label}: no digest summary card in the list`);
      else bad(`${name} ${label}: the digest card is still on /mail`, JSON.stringify(leftovers));
      const proseUrl = base + url + '#pane=prose';
      await page.goto(proseUrl, { waitUntil: 'domcontentloaded' });
      await page.reload({ waitUntil: 'networkidle' });
      const stillProse = await page.$('#digpane .brief-body');
      if (!stillProse) ok(`${name} ${label}: and the old prose deep link opens nothing`);
      else bad(`${name} ${label}: #pane=prose still renders the digest`);
      await page.goto(base + url, { waitUntil: 'domcontentloaded' });
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForSelector('#digfilters .chip', { timeout: 10000 }).catch(() => null);

      /* NO ARCHIVE BY HAND. Alex, 2026-10-03: "Remove the ability to
         manually make a mail digest." The three daily briefs file it; the
         Current Digest offers no button to do it between them. */
      const arch = await page.$('#diglist .dg-archive');
      if (!arch) ok(`${name} ${label}: no manual archive on the current digest`);
      else bad(`${name} ${label}: a manual archive button is back on the current digest`);

      /* THE OBLIGATIONS READ THESE FOR HIM. Alex, 2026-09-19: "action | memory |
       * awareness | ephemeral won't have read/unread status shown, since the
       * Obligations read it on behalf of the user and featured it in the Brief if
       * needed." So on one of those tiers, no unread rule down the rows.
       * "1,232 unread" used to be mostly action items already on his to-do
       * list — a backlog that did not exist. */
      await tap('Memory');
      const onHandled = await page.evaluate(() => ({
        marked: document.querySelectorAll('#diglist .card-digest.unread, #diglist .card-digest.read').length,
        rows: document.querySelectorAll('#diglist .card-digest').length,
        archive: !!document.querySelector('#diglist .dg-archive'),
      }));
      if (onHandled.rows && !onHandled.marked && !onHandled.archive)
        ok(`${name} ${label}: memory carries no read marks and offers no archive (${onHandled.rows} rows)`);
      else bad(`${name} ${label}: read state on a handled tier`, JSON.stringify(onHandled));
      await tap('Current digest');
      await page.goto(base + url, { waitUntil: 'networkidle' });
      await page.waitForTimeout(200);
      await page.waitForTimeout(150);
      // Bold means unread and nothing else. Read on the flat `by date` list,
      // where the rows are cards; the roll-up draws `.dg-line` instead.
      /* Bold means unread and nothing else — and only the two tiers he reads
         himself carry the state at all, so a row with neither class must NOT be
         bold. A `:not(.read)` selector would have painted every handled row as
         unread, which is the bug this pins. */
      const weights = await page.$$eval('#diglist .card-digest', (cs) => cs.map((c) => [
        c.classList.contains('unread') ? 'unread' : c.classList.contains('read') ? 'read' : 'none',
        getComputedStyle(c.querySelector('.ob-title')).fontWeight]));
      const boldRule = weights.length && weights.every(([st, w]) => (st === 'unread' ? Number(w) >= 600 : Number(w) < 600));
      if (boldRule) ok(`${name} ${label}: only unread items are bold; handled tiers carry no state (${weights.length} checked)`); else bad(`${name} ${label}: bold rule`, JSON.stringify(weights));
      /* The unjudged live in `pending` now, not on top of the unread list.
       * The count stays on the row either way, so a stalled pipeline and an
       * empty digest still cannot look the same. */
      const notHere = await page.$$('#diglist .card-waiting');
      if (!notHere.length) ok(`${name} ${label}: unread is only judged mail — the unjudged are in pending`);
      else bad(`${name} ${label}: waiting cards on the unread list`, String(notHere.length));
      await tap('pending');
      const waitingRows = await page.$$('#diglist .card-waiting');
      if (waitingRows.length === 2) ok(`${name} ${label}: pending lists the threads the job has not judged`); else bad(`${name} ${label}: waiting rows`, String(waitingRows.length));
      // A waiting thread with no known sender still names the problem, and the
      // Ignore button says why it cannot act rather than doing nothing.
      const noSender = await page.$$eval('#diglist .card-waiting .card-who', (ns) => ns.map((n) => n.textContent));
      if (noSender.includes('sender not known yet')) ok(`${name} ${label}: a sender the work list could not name says so`); else bad(`${name} ${label}: waiting sender`, noSender.join('|'));
      await page.click('#diglist .card-waiting'); await page.waitForTimeout(400);
      const wtxt = await page.$eval('#digpane .read-msg-text', (n) => n.textContent).catch(() => '');
      const wnote = await page.$eval('#digpane .what', (n) => n.textContent).catch(() => '');
      if (wtxt.length > 20 && /Not judged yet/.test(wnote)) ok(`${name} ${label}: a waiting thread opens to its message, marked unjudged`);
      else bad(`${name} ${label}: waiting pane`, `${wnote.slice(0, 40)} | ${wtxt.slice(0, 40)}`);
      await page.goto(base + url, { waitUntil: 'networkidle' });
      const said = await page.$('#diglist .card-msg');
      if (!said) ok(`${name} ${label}: no briefs on the digest`); else bad(`${name} ${label}: a brief is still listed`);
      const backlog = await page.$eval('#digcount', (n) => n.textContent);
      if (/3 pending/.test(backlog)) ok(`${name} ${label}: the backlog is shown on every view`); else bad(`${name} ${label}: backlog line`, backlog);
      /* THE COUNT LINE SAYS WHAT IS TRUE OF THE SET. Alex, 2026-09-21, on
         "23 judged ephemeral not yet cleared": "that is not the right
         verbiage, it is more like they are archived." On a tier he is not the
         reader of the toggle is hidden and the server ignores it, so calling
         the list uncleared described a queue that did not exist. Memory is
         the same case as ephemeral and is in this fixture. */
      await tap('Memory');
      const memLine = await page.$eval('#digcount', (n) => n.textContent);
      if (/judged memory, archived/.test(memLine) && !/cleared|unread/.test(memLine)) ok(`${name} ${label}: a tier the assistant read for him reads as archived, not as a queue`);
      else bad(`${name} ${label}: memory count line`, memLine);
      /* On ALL, explicitly. The page opens on the digest now — Alex,
         2026-09-19: "the default mail view should be digest" — and the sender
         roll-up is about the whole judged set, so it has to say which view it
         is measuring rather than inheriting whatever the default happens to
         be. Every check below this line was written against All. */
      await tap('All');
      /* The toggle is not offered on All at all since 2026-09-21 — "the
         unread only toggle still applies on categories other than digest" —
         because All means everything judged and narrowing it contradicted the
         pill's own rule. So there is nothing to switch off here; the sender
         roll-up below already has the whole judged set. */
      const allToggle = await page.$$('#digfilters .toggle');
      if (!allToggle.length) ok(`${name} ${label}: no unread toggle on All — it means everything judged`);
      else bad(`${name} ${label}: All still offers the unread toggle`);
      await page.waitForTimeout(200);
      await tap('By sender');
      const heads = await page.$$eval('#diglist .sec-title', (hs) => hs.map((h) => h.textContent.trim()))
        .then((hs) => hs.filter((h) => /@|unknown sender/.test(h)));
      /* Biggest group first, and among equals the one who wrote most recently
       * — "a loud newsletter must not outrank a person who wrote once this
       * morning". The fixture's unread set is one each, so this pins the
       * tie-break: SaunaCo (Sep 5 16:10) above FlightAware (Sep 4 12:05). */
      /* Biggest group first, and among equals the one who wrote most recently
       * — "a loud newsletter must not outrank a person who wrote once this
       * morning". The fixture's unread set is one each, so this pins the
       * tie-break: SaunaCo (Sep 5 16:10) leads. Every head carries its
       * count, which is what makes the groups comparable at a glance. */
      /* Biggest group first, then the singles newest-first: FlightAware has two,
         then SaunaCo (Sep 5 16:10), the newsletter (Sep 5 09:00), DigiKey
         (Sep 2) and the hotel (Sep 1). A loud sender leads on volume, and among
         equals the one who wrote most recently. */
      const wantHeads = 'alerts@flightaware.com|kyle@saunaco.example|newsletters@bizweekly.example|orders@digikey.com|reservations@ihg.com';
      if (heads.length === 5 && heads.every((h) => /·\s*\d+$/.test(h))
          && heads.map((h) => h.split(/\s/)[0]).join('|') === wantHeads)
        ok(`${name} ${label}: by sender, biggest first and newest among equals, with counts (${heads.join(', ')})`);
      else bad(`${name} ${label}: by sender`, heads.join('|'));
      /* With the toggle off, All is the whole archive — every tier, including
       * the ones he has already cleared and the ones the assistant read for him.
       * The toggle was switched off above and stays off. */
      const tiers = await page.$$eval('#diglist .card-digest .card-kind', (ks) => ks.map((k) => k.textContent.trim()));
      if (tiers.includes('action') && tiers.includes('memory')) ok(`${name} ${label}: with the toggle off, every tier is listed`);
      else bad(`${name} ${label}: all tiers`, tiers.join('|'));
      /* Every card carries the category the triage gave it. Alex,
       * 2026-09-19: "do the emails in the list have been through the
       * categorization engine? if so show the category as a pill." */
      /* Silenced mail is never in All. Alex, 2026-09-19: "silent senders
       * should not show there." It is the ignore list working; listing it in
       * the default view is the one place that decision gets undone. */
      if (!tiers.includes('silent')) ok(`${name} ${label}: silenced senders stay out of All`);
      else bad(`${name} ${label}: a silent row is in All`, tiers.join('|'));
      const KNOWN = ['action', 'memory', 'awareness', 'newsletter', 'digest', 'ephemeral', 'open task'];
      if (tiers.length >= 2 && tiers.every((t) => KNOWN.includes(t)))
        ok(`${name} ${label}: each row shows its category (${[...new Set(tiers)].join(', ')})`);
      else bad(`${name} ${label}: category pills`, tiers.join('|') || '(none)');
      /* The toggle stays OFF from here down: every check below is about the
         whole judged set. It used to be clicked here to turn it off, back when
         the page opened unread-only on All; the page opens on the digest now
         and the switch was already thrown above, so clicking again turned it
         back ON and the "first card" became a newsletter instead of the debt
         these assertions are about. */
      await tap('action');
      const onlyAction = await page.$$eval('#diglist .card-digest .card-kind', (ks) => ks.map((k) => k.textContent));
      if (onlyAction.length && onlyAction.every((t) => /^(action|open task)$/.test(t))) ok(`${name} ${label}: a tier chip filters the history (${onlyAction.join(', ')})`);
      else bad(`${name} ${label}: tier filter`, onlyAction.join('|'));
      // `pending` is its own place on the row now, not a banner over every list.
      await tap('pending');
      const wOnly = await page.$$eval('#diglist .card', (cs) => cs.map((c) => c.className.includes('card-waiting')));
      if (wOnly.length === 2 && wOnly.every(Boolean)) ok(`${name} ${label}: pending holds only the unjudged`); else bad(`${name} ${label}: pending`, wOnly.join(','));
      await tap('all');
      await tap('By date');
      const first = await page.$('#diglist .card-digest');
      if (first) {
        await first.click(); await page.waitForTimeout(400);
        const msg = await page.$('#digpane .read-msg-text');
        const txt = msg ? await msg.evaluate((n) => n.textContent) : '';
        if (msg && txt.length > 20 && !/no readable text/.test(txt)) ok(`${name} ${label}: opening an item shows the message text`);
        else bad(`${name} ${label}: message pane`, txt.slice(0, 80));
        /* VISIBLE, not merely present. Alex, 2026-09-19: "on the mail pane,
         * add an Ignore emails from this sender button." It was there — and
         * hidden on every desktop, because it wore `.pane-back`, which the wide
         * layout hides since there is nothing to go back from. This assertion
         * used to read the DOM, found the button, and passed while he could not
         * see it. So it asks the browser whether it is on screen. */
        // Anchors count: "Open in Gmail" is an act and looks like one, so it
        // is a link styled as a button rather than a button.
        const shown = await page.$$eval('#digpane button, #digpane a.pane-act', (bs) => bs
          .filter((b) => b.offsetParent !== null && b.getBoundingClientRect().height > 0)
          .map((b) => b.textContent.trim()));
        /* The pair names the classification, both ways. Alex, 2026-09-19,
         * of "read customerservice@co452c.example in full from now on": "what
         * does this mean" — it reads as "show me the whole body", and what it
         * does is put the sender on the newsletter list. */
        /* Named by where it puts things. Alex, 2026-09-19, twice: "what
         * does this mean" and "I still don't get what 'treat as newsletter'
         * does" — it named a category rather than an effect. */
        /* Only on the two ambient tiers, where the move means something.
         * Alex, 2026-09-19: "'Move to Newsletters' should probably only
         * exist for items already set to Digest?" The thread open here is an
         * Action — a debt — so offering to reclassify it as light reading is
         * exactly what should NOT be here. */
        if (!shown.some((t) => /^Move to /.test(t))) ok(`${name} ${label}: no newsletter move on an Action`);
        else bad(`${name} ${label}: move offered on an Action`, shown.join(' | '));
        if (shown.includes('Open in Gmail')) ok(`${name} ${label}: and Gmail is an act like the others`);
        else bad(`${name} ${label}: Gmail link`, shown.join(' | '));
        // "Silence", the word the tier uses. Alex, 2026-09-19.
        if (shown.some((t) => /^Silence [^ ]+@/.test(t))) ok(`${name} ${label}: so is "Silence <sender>"`);
        else bad(`${name} ${label}: no visible silence button`, shown.join(' | ') || '(nothing visible)');
        /* The block says what is already true before it offers an act. Alex,
         * 2026-09-19: "if they are already silent, we should show why they
         * were silent." */
        const whys = await page.$$eval('#digpane .mail-acts-why', (ns) => ns.map((n) => n.textContent.trim()));
        const head = await page.$eval('#digpane .mail-acts-head', (n) => n.textContent.trim()).catch(() => '');
        if (head === 'Actions') ok(`${name} ${label}: the block is headed as what it is`);
        else bad(`${name} ${label}: sender block head`, head || '(none)');
        /* A thread that is still a debt hands him the task, from the actions
         * row. Alex, 2026-09-19: "move 'open it on To Do' to the actions
         * bar, relabel 'Open Task'." */
        if (shown.includes('Open Task')) ok(`${name} ${label}: an open obligation offers its task`);
        else bad(`${name} ${label}: Open Task`, shown.join(' | ') || '(none)');
        /* And a reply box at the foot of the thread — which DRAFTS. Sending is
         * a separate tap on a button that names the recipient. */
        /* A reply he types may send on his tap. Alex, 2026-09-19: "Gmail
         * sending is fine if it is manual, I am writing the response." The
         * Send button names the recipient, which is what makes a tap an
         * approval — the same rule the Outbox's Send follows. */
        const reply = await page.$$eval('#digpane .mail-reply .replybox button', (bs) => bs.map((b) => b.textContent.trim()));
        if (reply[0] === 'Save draft' && /^Send to .+/.test(reply[1] ?? ''))
          ok(`${name} ${label}: the reply box drafts or sends, and Send names the recipient (${reply.join(', ')})`);
        else bad(`${name} ${label}: reply box`, reply.join(' | ') || '(none)');
        const measure = await page.$eval('#digpane .what', (n) => getComputedStyle(n).maxWidth).catch(() => '');
        if (measure === 'none') ok(`${name} ${label}: the summary fills the pane like the message under it`);
        else bad(`${name} ${label}: summary is still capped`, measure);
        if (shown.some((t) => /^Silence everyone @/.test(t))) ok(`${name} ${label}: and the domain, as its own decision`);
        else bad(`${name} ${label}: no visible domain-silence button`, shown.join(' | '));
        /* And it ASKS before it acts, with the numbers that would actually
         * change. Alex, 2026-09-19: "we should have a confirmation" and "I
         * don't understand where 1825 archived came from". */
        await page.evaluate(() => [...document.querySelectorAll('#digpane .silence button')]
          .find((b) => /^Silence [^ ]+@/.test(b.textContent.trim()))?.click());
        await page.waitForTimeout(500);
        const confirm = await page.$$eval('#digpane .silence-ask button', (bs) => bs.map((b) => b.textContent.trim()));
        if (confirm.join(',') === 'Silence,Cancel') ok(`${name} ${label}: silencing asks first`);
        else bad(`${name} ${label}: no confirmation`, confirm.join(',') || '(none)');
        const says = await page.$eval('#digpane .silence-what', (n) => n.textContent).catch(() => '');
        if (/message|inbox|nothing moves/i.test(says)) ok(`${name} ${label}: and says what would move (${says.slice(0, 60)}…)`);
        else bad(`${name} ${label}: confirmation text`, says || '(none)');
        await page.evaluate(() => [...document.querySelectorAll('#digpane .silence-ask button')]
          .find((b) => b.textContent.trim() === 'Cancel')?.click());
        await page.waitForTimeout(200);
        /* ...and on a Digest thread the move IS offered, because Digest and
         * Newsletter are the two ambient tiers the button swaps between. */
        // Back to the list first: on a phone the panes take turns, so the list
        // is not in the layout while a message is open.
        await page.goto(base + url, { waitUntil: 'networkidle' });
        // The Digest pill split into Current and Never on 2026-09-21; the
        // default view is Current, so there is nothing to tap.
        await page.click('#diglist .card-digest'); await page.waitForTimeout(600);
        const onDigest = await page.$$eval('#digpane button, #digpane a.pane-act', (bs) => bs
          .filter((b) => b.offsetParent !== null).map((b) => b.textContent.trim()));
        if (onDigest.includes('Move to Newsletters')) ok(`${name} ${label}: the move is offered on a Digest thread`);
        else bad(`${name} ${label}: no move on a Digest thread`, onDigest.join(' | '));
        await tap('all');
      } else bad(`${name} ${label}: no digest card to open`);
    }

    if (name === 'briefs') {
      const cards = await page.$$('#sdlist .card-msg');
      if (cards.length >= 1) ok(`${name} ${label}: messages listed (${cards.length})`); else bad(`${name} ${label}: no messages`);
    }

    if (name === 'projects') {
      /* ONE PROJECTS TAB. Alex, 2026-10-04: "lets combine By Project and
         Project under to-do. so By Project needs a New Project button, and
         then for each project a way to edit it" — and "Lets hide the No
         Project tasks". /projects opens By project; the doors are at the head
         of its list; each project's head carries its edit. */
      const sel = await page.$$eval('#filt button[aria-selected=true]', (ns) => ns.map((n) => n.textContent.trim()));
      const addr = await page.evaluate(() => location.pathname + location.search);
      if (sel.some((t) => t.startsWith('By project')) && addr === '/todo?f=projects') ok(`${name} ${label}: /projects opens To Do on By project (${addr})`);
      else bad(`${name} ${label}: To Do tabs`, `${sel.join(', ')} at ${addr}`);
      const oldTab = await page.$('#filt button[data-f=projectlist]');
      if (!oldTab) ok(`${name} ${label}: there is no separate Projects tab`); else bad(`${name} ${label}: the Projects tab is still there`);
      const tools = await page.$$eval('#tasklist .proj-tools button', (bs) => bs.map((b) => b.textContent.trim()));
      if (tools.join('|') === '+ new project|what leads the briefs|archived') ok(`${name} ${label}: the project doors head the list`);
      else bad(`${name} ${label}: project doors`, tools.join('|'));
      const edits = await page.$$('#tasklist .proj-head .proj-edit');
      if (edits.length >= 2) ok(`${name} ${label}: every project has an edit (${edits.length})`); else bad(`${name} ${label}: edits`, String(edits.length));
      const heads = await page.$$eval('#tasklist .sec-title', (hs) => hs.map((h) => h.textContent));
      const loose = await page.$eval('#tasklist .proj-loose', (n) => n.textContent).catch(() => '');
      if (!heads.some((h) => /^no project/.test(h)) && /on no project — hidden here/.test(loose))
        ok(`${name} ${label}: no-project tasks are hidden, and counted on the last line`);
      else bad(`${name} ${label}: no-project`, `${heads.join('|')} / ${loose}`);

      // What leads the briefs: one card per leading project, each with its on-track line.
      await page.click('#tasklist .proj-tools button:nth-of-type(2)');
      await page.waitForTimeout(300);
      const cards = await page.$$('#taskpane .pr-card');
      const notes = await page.$$('#taskpane .pr-card textarea');
      if (cards.length >= 1 && notes.length === cards.length)
        ok(`${name} ${label}: one card per leading project (${cards.length}), each with its on-track line`);
      else bad(`${name} ${label}: ranking`, `${cards.length} cards, ${notes.length} notes`);

      // Starting one. Alex, 2026-09-16: "how do I manually add projects?"
      await page.goto(base + url, { waitUntil: 'networkidle' });
      await page.waitForTimeout(300);
      await page.click('#tasklist .proj-tools button:nth-of-type(1)');
      await page.waitForTimeout(200);
      const fields = await page.$$eval('#taskpane .pr-new .pr-label', (ls) => ls.map((l) => l.textContent));
      const wants = ['name', 'tag', 'goal', 'on track', 'match people', 'match words'];
      if (wants.every((w) => fields.some((f) => f.includes(w))))
        ok(`${name} ${label}: a project can be started here (${fields.length} fields)`);
      else bad(`${name} ${label}: new-project form`, fields.join('|'));
      // The tag follows the name until he touches it.
      await page.fill('#taskpane .pr-new input', 'Hangar lease');
      await page.waitForTimeout(100);
      const tagVal = await page.$$eval('#taskpane .pr-new input', (is) => is[1].value);
      if (tagVal === 'hangar-lease') ok(`${name} ${label}: the tag follows the name`); else bad(`${name} ${label}: tag`, tagVal);
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (wide <= 1) ok(`${name} ${label}: the form does not push the page sideways`); else bad(`${name} ${label}: form overflows by ${wide}px`);

      // Editing prefills, fixes the tag, never offers the focus box, and carries Archive.
      await page.goto(base + url, { waitUntil: 'networkidle' });
      await page.waitForTimeout(300);
      await page.click('#tasklist .proj-head .proj-edit'); await page.waitForTimeout(400);
      const editTitle = await page.$eval('#taskpane .pane-title', (n) => n.textContent).catch(() => '');
      const tagDisabled = await page.$$eval('#taskpane .pr-form input', (is) => is[1]?.disabled === true).catch(() => false);
      if (/^editing /.test(editTitle) && tagDisabled) ok(`${name} ${label}: editing opens on the project, with the tag fixed`);
      else bad(`${name} ${label}: edit form`, `${editTitle} | tag disabled: ${tagDisabled}`);
      const leadBox = await page.$$('#taskpane .pr-form .pr-check');
      if (!leadBox.length) ok(`${name} ${label}: editing never silently reorders what leads`); else bad(`${name} ${label}: edit form offers the focus box`);
      await page.click('#taskpane .pr-archive'); await page.waitForTimeout(150);
      const ask = await page.$eval('#taskpane .outcomebox', (n) => n.textContent).catch(() => '');
      if (/Archive .*stops leading the briefs/.test(ask) && /bring it back/.test(ask)) ok(`${name} ${label}: archiving asks first, and says it is reversible`);
      else bad(`${name} ${label}: archive confirm`, ask.slice(0, 80));

      // And the way back from an archive.
      await page.goto(base + url, { waitUntil: 'networkidle' });
      await page.waitForTimeout(300);
      await page.click('#tasklist .proj-tools button:nth-of-type(3)'); await page.waitForTimeout(300);
      const archTitle = await page.$eval('#taskpane .pane-title', (n) => n.textContent).catch(() => '');
      const archMeta = await page.$eval('#taskpane .ob-meta', (n) => n.textContent).catch(() => '');
      if (archTitle === 'archived' && /not deleted/.test(archMeta)) ok(`${name} ${label}: archived is a view you can get back from`);
      else bad(`${name} ${label}: archived view`, `${archTitle} | ${archMeta.slice(0, 50)}`);
    }

    /* PEOPLE ONLY, YOURS FIRST. Alex, 2026-09-22: "Lets make it people only
       to begin with … those [in the contact book] should be more high value
       people than non-contact book people." */
    if (name === 'people') {
      const heads = await page.$$eval('#pplist .sec-title', (hs) => hs.map((h) => h.textContent.trim()));
      if (heads[0]?.startsWith('Your people') && heads[1]?.startsWith('Others who wrote'))
        ok(`${name} ${label}: two circles, yours first (${heads.join(' | ')})`);
      else bad(`${name} ${label}: section heads`, heads.join(' | '));
      const line = await page.$eval('#ppcount', (n) => n.textContent).catch(() => '');
      if (/514 organisations and mailboxes not shown/.test(line)) ok(`${name} ${label}: what was left off is counted`);
      else bad(`${name} ${label}: count line`, line);
      const chips = await page.$$eval('#ppfilters button', (bs) => bs.map((b) => b.firstChild?.textContent?.trim()));
      if (chips.join(',') === 'Something open,Your people,Everyone') ok(`${name} ${label}: the chips are open, yours, everyone`);
      else bad(`${name} ${label}: chips`, chips.join(','));
      const tomAge = await page.$$eval('#pplist .ob', (rs) => rs.map((r) => r.textContent)).then((t) => t.find((x) => /Pete Rourke/.test(x)) ?? '');
      if (/text · /.test(tomAge)) ok(`${name} ${label}: a row says how you last spoke`); else bad(`${name} ${label}: channel on the row`, tomAge);
      /* The deep link from To Do carries `who` — here an address — while the
         row's key is something else for everyone the page knows best. */
      await page.goto(base + '/system', { waitUntil: 'networkidle' });
      await page.goto(base + url + '#pane=' + encodeURIComponent('+1 (813) 555-0142'), { waitUntil: 'networkidle' });
      await page.waitForTimeout(300);
      const opened = await page.$eval('#pppane .pane-title', (n) => n.textContent).catch(() => '');
      if (opened === 'Pete Rourke') ok(`${name} ${label}: a To Do link by phone number opens the person`);
      else bad(`${name} ${label}: deep link by handle`, opened || '(nothing opened)');
    }

    if (name === 'reference') {
      const groups = await page.$$('#reflist .ref-row');
      if (groups.length >= 3) ok(`${name} ${label}: reference is grouped (${groups.length} groups)`);
      else bad(`${name} ${label}: expected trip groups, got ${groups.length}`);
      // Three sections. Alex, 2026-09-05: "split that up into bookings,
      // Documents, Filed Mail."
      /* `archived` is filtered out before the comparison, not asserted against:
         it appears the moment he archives a trip, and this ran against the live
         repo, so the check broke the first time he used the button rather than
         the first time the page did. What it is actually for is that FILED MAIL
         is not a section here — it lives on the digest. */
      const secs = (await page.$$eval('#reflist .ref-sec', (hs) => hs.map((h) => h.dataset.sec)))
        .filter((x) => x !== 'archived');
      if (secs.join(',') === 'bookings,documents') ok(`${name} ${label}: two sections in order (filed mail lives on the digest)`);
      else bad(`${name} ${label}: sections`, secs.join(','));
      /* Three chips, or four when something is on the shelf. Alex,
         2026-09-19: "a filter to see Archived filings." The archived chip
         exists only when there is something archived — a filter over an empty
         set is a control that teaches you it does nothing. */
      const chipNames = await page.$$eval('#reffilters .chip', (cs) => cs.map((c) => c.textContent.trim()));
      const shelved = await page.$$eval('#reflist [data-sec="archived"]', (ns) => ns.length);
      const wantChips = shelved ? 4 : 3;
      if (chipNames.length === wantChips && chipNames.slice(0, 3).join(',') === 'all,bookings,documents')
        ok(`${name} ${label}: section chips (${chipNames.join(', ')})`);
      else bad(`${name} ${label}: chips`, chipNames.join(','));
      /* ARCHIVED IS THE ONE SECTION `all` LEAVES OUT — a shelf you cannot help
         seeing is not a shelf. Vacuous while nothing is archived, and the point
         is that it stays true the day something is. */
      const shownArchived = await page.$$eval('#reflist [data-sec="archived"]', (ns) => ns.filter((n) => !n.hidden).length);
      if (!shownArchived) ok(`${name} ${label}: archived trips are out of the default view`);
      else bad(`${name} ${label}: an archived trip is in "all"`, String(shownArchived));

      /* The button is on trips and nowhere else. Alex: "specially for
         trips" — a filed document is one line pointing at Drive, with nothing
         to put away. `data-ref` is a bare index for a trip and `doc-N` for a
         document, which is how the two are told apart here. */
      const acts = await page.$$eval('.ref-pane', (ps) => ps.map((p) => ({
        ref: p.dataset.ref,
        btn: p.querySelector('.trip-archive')?.textContent?.trim() ?? null,
      })));
      const trips = acts.filter((a) => !/^doc-/.test(a.ref));
      const docs = acts.filter((a) => /^doc-/.test(a.ref));
      if (trips.length && trips.every((t) => /^(Archive this trip|Restore to bookings)$/.test(t.btn ?? '')))
        ok(`${name} ${label}: every trip offers Archive (${trips.length})`);
      else bad(`${name} ${label}: trip archive button`, JSON.stringify(trips.slice(0, 3)));
      if (docs.every((d) => d.btn === null)) ok(`${name} ${label}: and no filed document does (${docs.length} checked)`);
      else bad(`${name} ${label}: archive offered on a document`, JSON.stringify(docs.filter((d) => d.btn).slice(0, 3)));
      await page.click('#reffilters .chip[data-k="documents"]');
      const shown = await page.$$eval('#reflist [data-sec]', (ns) => ns.filter((n) => !n.hidden).map((n) => n.dataset.sec));
      if (shown.length && shown.every((x) => x === 'documents')) ok(`${name} ${label}: a chip shows one section`);
      else bad(`${name} ${label}: chip filter`, shown.join(','));
      await page.click('#reffilters .chip[data-k="all"]');
      // A group must open at rest — the page should show something, not an
      // instruction to click. Where both panes fit, that is the first group.
      // On a phone the panes take turns and the list IS the page: opening a
      // group there hid all nine rows, which the rows-visible guard caught
      // while this check demanded the opposite. Same breakpoint as .split.
      const wide = await page.evaluate(() => matchMedia('(min-width: 44rem)').matches);
      const open = await page.$('#refpane .ref-pane:not([hidden])');
      if (wide) {
        if (open) ok(`${name} ${label}: the first group is open on load`);
        else bad(`${name} ${label}: nothing shown until clicked`);
      } else if (!open) ok(`${name} ${label}: on a phone the list is the page, no pane over it`);
      else bad(`${name} ${label}: a pane opened over the list on a phone`);
    }

    if (name === 'notes') {
      // The HTML comments that instruct the compaction routine were rendering as
      // visible text. They must not.
      const text = await page.evaluate(() => document.body.innerText);
      if (!text.includes('<!--')) ok(`${name} ${label}: now.md's comments are not shown`);
      else bad(`${name} ${label}: an HTML comment from now.md is visible`);
      const cards = await page.$$('.notes-grid .card');
      if (cards.length >= 1) ok(`${name} ${label}: now.md is cards, one per section (${cards.length})`);
      else bad(`${name} ${label}: no section cards`);
    }

    // Reading is grouped by sender and each group carries the one control that
    // acts on a sender. Three items from two senders must render as two groups.
    if (name === 'reading') {
      const groups = await page.$$('.read-group');
      if (groups.length === 2) ok(`${name} ${label}: items are grouped by sender (${groups.length} groups)`);
      else bad(`${name} ${label}: expected 2 sender groups, got ${groups.length}`);
      const ignore = await page.$$('.read-ignore');
      if (ignore.length === 2) ok(`${name} ${label}: every sender group has an Ignore button`);
      else bad(`${name} ${label}: expected 2 ignore buttons, got ${ignore.length}`);
      // Selecting an item fills the right pane rather than leaving the page.
      const subj = await page.$('.read-subject.tappable');
      if (subj) { await subj.click(); await page.waitForTimeout(300); }
      const detail = await page.$('#readpane .read-detail');
      if (detail) ok(`${name} ${label}: a newsletter opens in the pane`);
      else bad(`${name} ${label}: selecting a subject did not fill the pane`);
    }

    const shot = `${SHOTS}/${name}-${label}.png`;
    await page.screenshot({ path: shot, fullPage: true });

    if (errors.length) bad(`${name} ${label}: JS error on load`, errors[0]);
    else ok(`${name} ${label}: loads without error`);

    await overflow(page, name, label, 'reading a message');
    await ctx.close();
  }
}

await browser.close();
server.close();
console.log(`\nscreenshots in ${SHOTS}`);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
