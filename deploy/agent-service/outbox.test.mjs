/**
 * Tests for the outbox state machine — the thing standing between "the agent
 * wrote a message" and "a message was sent as Alex".
 *
 * Every negative case here is a way a message gets delivered that nobody meant
 * to send, which is why they are tests rather than comments.
 */
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listOutbox, setStatus, markInviteSent } from './outbox.mjs';

let pass = 0, fail = 0;
const ok = (m) => { console.log(`  ok   ${m}`); pass++; };
const bad = (m, e) => { console.log(`  FAIL ${m}${e ? ' -> ' + e : ''}`); fail++; };

const dir = await mkdtemp(join(tmpdir(), 'outbox-'));

async function draft(name, status = 'draft', to = '+15551110000') {
  await writeFile(join(dir, name),
    `---\ntype: outbox\nto: ${to}\nchat_id: -\nstatus: ${status}\n` +
    `created: 2026-08-28 12:00\napproved_at: -\nsent_at: -\nerror: -\n---\n\nhello there\n`);
  return name;
}

async function accepts(label, fn) {
  try { await fn(); ok(label); } catch (e) { bad(label, e.message); }
}
async function refuses(label, fn) {
  try { await fn(); bad(`${label} -> WAS ALLOWED`); }
  catch (e) { ok(`${label} -> refused (${e.message})`); }
}

console.log('Outbox state machine');

await draft('a.md');
await accepts('draft can be approved', () => setStatus(dir, 'a.md', 'approved', 'alex@rivera.example'));
const after = await readFile(join(dir, 'a.md'), 'utf8');
ok(`approval records who (${/approved_at: .*by (\S+)/.exec(after)?.[1] ?? 'MISSING'})`);
if (!/by alex@rivera\.example/.test(after)) bad('approver not recorded in the file');

await draft('b.md');
await accepts('draft can be discarded', () => setStatus(dir, 'b.md', 'discarded'));

// Re-approving anything that already moved on is how a message gets sent twice,
// or resurrected after a deliberate discard.
await refuses('an approved draft cannot be re-approved', () => setStatus(dir, 'a.md', 'approved'));
await refuses('a discarded draft cannot be approved', () => setStatus(dir, 'b.md', 'approved'));
await draft('c.md', 'sent');
await refuses('a sent message cannot be re-approved', () => setStatus(dir, 'c.md', 'approved'));
await draft('d.md', 'failed');
await refuses('a failed message cannot be re-approved', () => setStatus(dir, 'd.md', 'approved'));

// The service must never be able to claim something was sent — that is the
// Mac's word, written back after the fact.
await draft('e.md');
await refuses('the service cannot set status: sent', () => setStatus(dir, 'e.md', 'sent'));
await refuses('the service cannot invent a status', () => setStatus(dir, 'e.md', 'delivered'));

await refuses('path traversal in the id', () => setStatus(dir, '../../etc/passwd', 'approved'));
await refuses('absolute path in the id', () => setStatus(dir, '/etc/passwd', 'approved'));
await refuses('a draft that does not exist', () => setStatus(dir, 'nope.md', 'approved'));

const all = await listOutbox(dir);
const byId = Object.fromEntries(all.map((d) => [d.id, d]));
if (byId['a.md']?.status === 'approved' && byId['b.md']?.status === 'discarded'
    && byId['e.md']?.status === 'draft') ok('listing reflects the real statuses');
else bad('listing statuses wrong', JSON.stringify(all.map((d) => [d.id, d.status])));

if (byId['e.md']?.text === 'hello there') ok('body parsed');
else bad('body not parsed', byId['e.md']?.text);

const pending = all.filter((d) => d.status === 'draft').length;
if (pending === 1) ok('pending count counts only drafts');
else bad('pending count wrong', String(pending));

/* A calendar invite is the third kind. Alex, 2026-09-08: adding an attendee
 * mails a third party in his name, so it belongs on the page where he already
 * approves that, behind the same identity fence — not in a CLI that only works
 * while a chat session is open. The round trip is what can silently break: the
 * record is frontmatter, and a field that fails to parse turns an invite into
 * a text with no attendees, which would send nothing and look fine. */
console.log('\ninvites');
{
  const { draftInvite } = await import('../drafts.mjs');
  const vault = await mkdtemp(join(tmpdir(), 'obligations-inv-'));
  await mkdir(join(vault, 'outbox'), { recursive: true });
  const made = await draftInvite(vault, {
    who: 'Carl (Brava)', to: 'carl@co19e0.example', eventId: 'evt123',
    summary: 'Brava intro call', when: '2026-09-09 11:00–11:30', conference: true,
  });
  const [rec] = await listOutbox(join(vault, 'outbox'));
  if (rec?.kind === 'invite') ok('written and read back as an invite, not a text');
  else bad('kind wrong', rec?.kind);
  if (rec?.eventId === 'evt123') ok('it names the event it acts on');
  else bad('event id lost', rec?.eventId);
  if (rec?.attendees?.length === 1 && rec.attendees[0] === 'carl@co19e0.example') ok('the guest survives the round trip');
  else bad('attendees lost', JSON.stringify(rec?.attendees));
  if (rec?.conference === true) ok('the Meet flag survives');
  else bad('conference flag lost', String(rec?.conference));
  if (rec?.status === 'draft') ok('it is a draft — preparing is not sending');
  else bad('status wrong', rec?.status);

  // Only the party that actually delivered it may write `sent`, and only once.
  const sent = await markInviteSent(join(vault, 'outbox'), made.file, 'alex@rivera.example',
                                    { conference: 'https://meet.google.com/x' });
  if (sent.status === 'sent') ok('marked sent after the calendar call returned');
  else bad('not marked sent', JSON.stringify(sent));
  const [after] = await listOutbox(join(vault, 'outbox'));
  if (after.status === 'sent' && after.approvedAt?.includes('alex@rivera.example')) ok('the record names who approved it');
  else bad('approver not recorded', JSON.stringify([after.status, after.approvedAt]));
  if (after.conferenceUrl === 'https://meet.google.com/x') ok('the meeting link is kept on the record');
  else bad('conference url lost', after.conferenceUrl);
  await refuses('sending the same invite twice',
                () => markInviteSent(join(vault, 'outbox'), made.file, 'alex@rivera.example'));
  await refuses('marking a text as an invite sent', () => markInviteSent(dir, 'e.md', 'alex@rivera.example'));
}

/* The fence itself: attendees reach other people, so nothing may add them
 * without the identity of the person who tapped Send. */
console.log('\nthe attendee fence');
{
  const { addAttendees } = await import('../integrations/calendar-write.mjs');
  await refuses('adding attendees with nobody approving',
                () => addAttendees('/tmp', 'evt123', { attendees: ['carl@co19e0.example'] }));
  await refuses('an approved call with nobody to invite',
                () => addAttendees('/tmp', 'evt123', { attendees: [], approvedBy: 'alex@rivera.example' }));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
