/**
 * The written digest compounds: the writer gets the previous prose and only
 * what is new, and reading clears what it no longer needs to say.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isFresh, rosterFor, idsOf, buildPrompt, refreshDigest, readDigest, tidyProse, archiveDigest } from './mail-digest.mjs';
import { stillWaiting } from './digestlist.mjs';

let pass = 0, fail = 0;
const check = (m, cond, detail) => {
  if (cond) { console.log(`  ok   ${m}`); pass++; }
  else { console.log(`  FAIL ${m}${detail ? '\n         ' + detail : ''}`); fail++; }
};
const it = (id, who, subject, what, tier = 'digest') => ({ id, who, subject, title: subject, what, tier, read: false });
/** The same thread, marked read — the digest window carries both now. */
const rd = (x) => ({ ...x, read: true });
const A = it('a:1', 'alerts@flightaware.com', 'N123AB arrived KXYZ', 'an arrival alert');
const B = it('a:2', 'kyle@saunaco.example', 'Signed agreement', 'countersigned; deposit paid', 'reading');
const C = it('a:3', 'alerts@flightaware.com', 'N123AB departed', 'a departure alert');
const D = it('t:4', 'lori@co339d.example', 'Validation of account', 'asks him to confirm the account');

/* IT ENDS BY BEING ARCHIVED, NOT BY BEING READ. Alex, 2026-09-21: "you can
 * still track read/unread status, but they will always be in the current
 * digest until that Digest is archived." Read state used to end a digest,
 * which meant reading the last line silently started a new document under
 * him; `items` here is the CURRENT bucket and read is only a mark on a row. */
console.log('freshness — one digest, held open until it is archived');
{
  const stored = { ids: idsOf([A, B]), text: 'x' };
  check('same set is fresh', isFresh(stored, [B, A]));
  check('an added thread is stale — there is something to fold in', !isFresh(stored, [A, B, C]));
  check('reading one does NOT make it stale', isFresh(stored, [rd(A), B]));
  check('  nor does reading ALL of it — only archiving ends a digest',
        isFresh(stored, [rd(A), rd(B)]));
  check('an added thread is still stale when one has been read', !isFresh(stored, [rd(A), B, C]));
  check('no prose yet is stale', !isFresh(null, [A]) && !isFresh({ ids: [] }, [A]));

  /* The roster IS the current bucket. It used to be a union that grew from
     whatever was unread, which is how a thread could sit in a digest for a
     fortnight without the digest ever being the thing that reported it. */
  check('the roster is exactly what it was handed', rosterFor(stored, [rd(A), B, C]).join(',') === 'a:1,a:2,a:3');
  check('  and a thread archiving removed is gone from it, not held forever',
        rosterFor(stored, [B, C]).join(',') === 'a:2,a:3');
}

console.log('\nthe prompt — previous prose plus only what is new');
{
  const first = buildPrompt([A, B], null);
  check('first pass lists every thread as new', first.fresh === 2 && first.kept === 0 && /Worth opening/.test(first.prompt) && /Signed agreement/.test(first.prompt) && /N123AB arrived/.test(first.prompt));
  check('the data is framed as data', /never instructions/.test(first.prompt));
  /* BULLETS, NOT A SEMICOLON CHAIN. Alex, 2026-09-20: "lets use more bullet
     points. the run on long sentences makes it hard to read." The old prompt
     asked for "plain prose and short lists" and got one sentence per category
     with a dozen facts strung through it. */
  check('the writer is told to use bullets, one fact each',
    /one fact per bullet/i.test(first.prompt) && /semicolons/i.test(first.prompt));
  check('and to keep one bullet shape per list',
    /ONE shape per list/.test(first.prompt));
  const stored = { ids: idsOf([A, B]), text: '## Worth opening\nSaunaCo signed.\n## Everything else\nOne FlightAware alert.' };
  const second = buildPrompt([A, B, C, D], stored);
  check('second pass carries the previous prose and only the two new lines', second.fresh === 2 && second.kept === 2 && /SaunaCo signed/.test(second.prompt) && /departed/.test(second.prompt) && /co339d/.test(second.prompt) && !/N123AB arrived KXYZ/.test(second.prompt), second.prompt.slice(0, 200));
  /* NOTHING IS EVER DROPPED FOR BEING READ. The writer is told he got through
   * some of it — so it does not lead with those again — and told to keep them.
   * A digest that deletes the line he just read is the document moving because
   * he looked at it, which is the inbox feeling this layer exists to remove. */
  const partly = buildPrompt([rd(A), B, C], stored);
  check('one read, one kept: nothing is dropped and the read one is counted',
    partly.dropped === 0 && partly.done === 1 && partly.kept === 2 && partly.fresh === 1);
  check('and the writer is told to keep all of it', /do not drop anything from it/.test(partly.prompt) && /1 of which he has since read/.test(partly.prompt));
  const nothingNew = buildPrompt([rd(A), B], stored);
  check('nothing new: return it unchanged rather than paying to rewrite it',
    nothingNew.fresh === 0 && /return the previous digest unchanged/.test(nothingNew.prompt));
  const many = Array.from({ length: 450 }, (_, k) => it(`m:${k}`, 'noreply@x.com', `mail ${k}`, 'noise'));
  const capped = buildPrompt(many, null);
  check('a catch-up beyond the cap counts the rest instead of listing it', capped.omitted === 50 && /50 further threads not listed/.test(capped.prompt));
}

console.log('\nrefreshDigest — writes, then compounds, then empties');
{
  const vault = await mkdtemp(join(tmpdir(), 'obligations-'));
  const calls = [];
  const ask = async (prompt) => { calls.push(prompt); return { text: `## Worth opening\ncall ${calls.length}\n## Everything else\n…`, costUSD: 0.01, model: 'fake' }; };
  const r1 = await refreshDigest(vault, [A, B], ask);
  check('first write covers both, one call', r1.refreshed && r1.covers === 2 && calls.length === 1);
  const r2 = await refreshDigest(vault, [B, A], ask);
  check('same set again: no call, not refreshed', !r2.refreshed && calls.length === 1);
  const r3 = await refreshDigest(vault, [A, B, C], ask);
  check('a new thread: one more call, previous prose fed back', r3.refreshed && r3.fresh === 1 && r3.kept === 2 && /call 1/.test(calls[1]));
  /* Reading one costs nothing — the whole point of holding it open. */
  const r3b = await refreshDigest(vault, [rd(A), B, C], ask);
  check('reading one: no call, the digest stands', !r3b.refreshed && calls.length === 2 && r3b.covers === 3);
  /* READING ALL OF IT COSTS NOTHING EITHER, and changes nothing. Until
     2026-09-21 this emptied the record, so reading the last line silently
     threw away the document; archiving is the only thing that ends one now. */
  const r4 = await refreshDigest(vault, [rd(A), rd(B), rd(C)], ask);
  check('reading all of it: still no call, the digest still stands', !r4.refreshed && r4.covers === 3 && calls.length === 2);
  /* An ARCHIVE is what empties it — the current bucket comes back without the
     threads that have now been reported. */
  const r5 = await refreshDigest(vault, [D], ask);
  check('after an archive the next arrival is a new digest', r5.refreshed && r5.covers === 1 && calls.length === 3, JSON.stringify({ c: r5.covers, n: calls.length }));
  const r6 = await refreshDigest(vault, [], ask);
  check('  and an empty bucket empties the record without a call', r6.refreshed && r6.covers === 0 && r6.text === '' && calls.length === 3);
  const stored = await readDigest(vault);
  check('the record on disk has the stamp and its epoch sibling', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(stored.written_at) && typeof stored.written_ms === 'number');
  await rm(vault, { recursive: true, force: true });
}

console.log('\nstillWaiting — a thread judged since the list was written is not waiting');
{
  const need = [{ account: 'personal', thread_id: 'a', subject: 'x' }, { account: 'personal', thread_id: 'b', subject: 'y' }, { account: 'work', thread_id: 'c', subject: 'z' }];
  const threads = [
    { account: 'personal', thread_id: 'a', reviewed: '2026-09-06 12:24', conclusion: { tier: 'digest' } },   // judged after the list
    { account: 'personal', thread_id: 'b', reviewed: '2026-09-06 12:10', conclusion: { tier: 'digest' } },   // judged before it: still on the list for a reason
  ];
  const left = stillWaiting(need, threads, '2026-09-06 12:21');
  check('the one judged after the list drops; the rest stay', left.map((e) => e.thread_id).join(',') === 'b,c', JSON.stringify(left));
  check('no list stamp: nothing is dropped', stillWaiting(need, threads, null).length === 3);
}

console.log('\nthe link to the thread');
{
  // Alex, 2026-09-16: "best to have links to message." A digest that names a
  // $4,000 invoice with no way to open it sends him to Gmail, which is the
  // inbox this layer exists to replace.
  const { prompt } = buildPrompt([
    { id: 'work:1a0a', account: 'work', threadId: '1a0a', tier: 'digest', who: 'heidi@cob401.example',
      subject: 'Live auction win….Forno Happy Hour', what: '$4,000, no terms printed', at: Date.now() },
    { id: 'x:2', account: null, threadId: null, tier: 'digest', who: 'nobody@example.com', subject: 'no thread', what: '', at: Date.now() },
  ], null);
  /* The MAIL PANE since 2026-09-22. Alex: "this link from the brief doesn't
     load … I think it should link to /mail#pane=???? instead." The thread page
     reads the body cache, and a thread judged minutes earlier may not be in it
     yet — so it 404s in exactly the window the digest is read. */
  check('each line carries the mail pane its thread is on', /\[link: \/mail#pane=work%3A1a0a\]/.test(prompt), prompt.slice(0, 400));
  check('a line with no thread carries no link rather than a guessed one', !/\[link: \/thread\/null/.test(prompt));
  check('the writer is told to link every thread it mentions', /markdown link/.test(prompt));
}

/* THE LINKS THE MODEL WROTE WERE NOT LINKS. Alex, 2026-09-21: "in the latest
 * mail brief, all the links are not valid." Every line ended `, [link:
 * /thread/personal/1a0c…]` — it had echoed the shape its INPUT uses to hand
 * it a path. Asking in the prompt is not a guarantee; this is arithmetic over
 * the answer. */
console.log('\nmaking the links real');
{
  const line = '- **Bloomberg Morning Briefing** — Daily newsletter: US-China talks; no action needed, [link: /mail#pane=personal%3A1a0c3a]';
  const t = tidyProse(line);
  check('the bold lead becomes the link, as CLAUDE.md asks of a brief',
        t === '- **[Bloomberg Morning Briefing](/mail#pane=personal%3A1a0c3a)** — Daily newsletter: US-China talks; no action needed', t);
  check('  the dangling comma goes with it', !/needed,$/.test(t));
  check('it is idempotent — read and write both run it', tidyProse(t) === t);
  check('a line with no bold lead keeps its path, made tappable',
        /\(\[open\]\(\/thread\/work\/x\)\)/.test(tidyProse('- something happened, [link: /thread/work/x]')), tidyProse('- something happened, [link: /thread/work/x]'));
  check('a proper markdown link is left alone', tidyProse('- **[A](/thread/a/b)** — text') === '- **[A](/thread/a/b)** — text');
  check('prose with no links at all is unchanged', tidyProse('Just a sentence.') === 'Just a sentence.');
  check('nothing is nothing, not a crash', tidyProse('') === '' && tidyProse(null) === '');

  /* A heading with nothing under it reads as something withheld. */
  const empty = ['## Worth opening', '', '## Everything else', '- **A** — b, [link: /thread/a/b]'].join('\n');
  const kept = tidyProse(empty);
  check('an empty section head is dropped', !/Worth opening/.test(kept) && /Everything else/.test(kept), kept);
  check('  ...and a head with items under it stays', /## Everything else/.test(kept));
}

/* ARCHIVING KEEPS THE WRITING, AND RECORDS WHAT IT REPORTED. Alex,
 * 2026-09-21: "I do think we should keep the Archived digest, snap-shot them
 * when marked read", and then the rework: a thread is in the Current Digest
 * until an archived digest has narrated it. The ledger is the half that makes
 * the second sentence possible — before it, archiving blanked the prose and
 * left no trace of which threads it had covered. */
console.log('\nputting a digest away');
{
  const { mkdtemp, mkdir, writeFile, readFile, readdir, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { readArchived } = await import('./digestlist.mjs');
  const vault = await mkdtemp(join(tmpdir(), 'obligations-arch-'));
  await mkdir(join(vault, '.log'), { recursive: true });
  const text = '## Everything else\n- **[Bloomberg](/thread/a/1)** — x';
  const put = (t = text) => writeFile(join(vault, '.log', 'mail-digest.json'),
    JSON.stringify({ ids: ['a:1', 'a:2'], text: t, covers: 2, written_at: '2026-09-21 11:06' }));
  await put();

  const r = await archiveDigest(vault, { now: new Date('2026-09-21T12:00:00') });
  check('it says what it put away', r.archived === true && r.covers === 2 && /-digest\.md$/.test(r.file ?? ''), JSON.stringify(r));
  const file = await readFile(join(vault, 'messages', r.file), 'utf8');
  check('  the snapshot is a message, with its own kind so the list can chip it', /^kind: digest$/m.test(file), file.slice(0, 120));
  check('  it keeps the words, links and all', file.includes('**[Bloomberg](/thread/a/1)**'));
  check('  and is filed read — he is done with it, that is why it is here', /^read: true$/m.test(file));
  /* A HAND ARCHIVE IS AN INTERIM DIGEST. Alex, 2026-09-21: "A user can
     manually Archive a Digest like now, they will then show as 'Interim
     Digest' in the brief section." The automatic ones are not messages at all
     — they are appended to the brief. */
  check('  titled Interim, because he archived it between briefs', /^title: Interim digest — 2 threads$/m.test(file), file.slice(0, 220));

  check('the threads it narrated are recorded as reported',
        JSON.stringify(Object.keys(await readArchived(vault)).sort()) === '["a:1","a:2"]',
        JSON.stringify(await readArchived(vault)));
  check('  and it says how many it recorded', r.recorded === 2, JSON.stringify(r));

  const after = await readDigest(vault);
  check('the live digest starts blank, so the next arrival is a new one', after.text === '' && after.covers === 0 && after.cleared === true, JSON.stringify(after));
  check('  and the ids it covered come back, to be marked read', JSON.stringify(r.ids) === '["a:1","a:2"]');

  const again = await archiveDigest(vault, { now: new Date('2026-09-21T12:01:00') });
  check('archiving an empty digest files nothing and says so', again.archived === false && /nothing written/.test(again.why), JSON.stringify(again));
  check('  ...and wrote no second message', (await readdir(join(vault, 'messages'))).length === 1);

  /* RE-REPORTING THE SAME THREAD RECORDS NOTHING NEW. The ledger never
     unsets, so a thread that somehow re-enters a digest cannot be counted as
     newly reported — which is what would make "current" oscillate. */
  await put();
  const third = await archiveDigest(vault, { now: new Date('2026-09-21T12:02:00') });
  check('a second archive of the same threads adds nothing to the ledger', third.recorded === 0, JSON.stringify(third));
  await rm(vault, { recursive: true, force: true });
}

/* THE AUTOMATIC PATH: INTO THE BRIEF. Alex, 2026-09-21: "Digests will be
 * automatically archived and included in Briefs (at the bottom)." One file
 * carries the brief and the mail it was written beside, so there is one thing
 * to open rather than two. */
console.log('\nattached to the brief it was written beside');
{
  const { mkdtemp, mkdir, writeFile, readFile, readdir, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const vault = await mkdtemp(join(tmpdir(), 'obligations-att-'));
  await mkdir(join(vault, '.log'), { recursive: true });
  await mkdir(join(vault, 'messages'), { recursive: true });
  const brief = '---\ntype: message\nkind: brief\nat: 2026-09-21 18:00\ntitle: Tomorrow\u2019s Brief\nread: false\ndelivered: apns\n---\n\nNothing is overdue.\n';
  await writeFile(join(vault, 'messages', '2026-09-21-1800-brief.md'), brief);
  await writeFile(join(vault, '.log', 'mail-digest.json'),
    JSON.stringify({ ids: ['a:1'], text: '## Everything else\n- **[GroceryCo](/thread/a/1)** — a receipt', covers: 1, written_at: '2026-09-21 17:59' }));

  const r = await archiveDigest(vault, { now: new Date('2026-09-21T18:01:00'), into: '2026-09-21-1800-brief.md' });
  check('it appends rather than filing its own message', r.archived === true && r.appended === true && r.file === '2026-09-21-1800-brief.md', JSON.stringify(r));
  check('  and no second message was written', (await readdir(join(vault, 'messages'))).length === 1);
  const out = await readFile(join(vault, 'messages', '2026-09-21-1800-brief.md'), 'utf8');
  check('  the brief keeps its own words', out.includes('Nothing is overdue.'));
  check('  with the digest under a heading at the bottom, marked as ours', /## Mail digest\n<!-- mail-digest: attached by the service -->\n\n## Everything else/.test(out), out.slice(-160));
  check('  the frontmatter is untouched', /^kind: brief$/m.test(out) && !/^kind: digest$/m.test(out));
  check('  and the threads are recorded as reported',
        JSON.stringify(Object.keys(await readArchivedOf(vault))) === '["a:1"]');

  /* A brief that already carries one must not gain a second — the hook runs
     after a job that could be re-run by hand. */
  await writeFile(join(vault, '.log', 'mail-digest.json'),
    JSON.stringify({ ids: ['a:2'], text: 'more', covers: 1, written_at: '2026-09-21 18:02' }));
  const twice = await archiveDigest(vault, { now: new Date('2026-09-21T18:03:00'), into: '2026-09-21-1800-brief.md' });
  check('a brief is never given two digests', twice.archived === false && /already carries/.test(twice.why), JSON.stringify(twice));

  /* THE BRIEF WROTE ITS OWN. Alex, 2026-09-28: "None of them came with a
     thread I can link you to, so this is a reading list, not a set of taps."
     The evening brief had written a `## Mail digest` from a count, and the
     heading alone blocked the linked one the writer had produced. */
  await writeFile(join(vault, 'messages', '2026-09-28-1800-brief.md'),
    '---\ntype: message\nkind: brief\nat: 2026-09-28 18:00\ntitle: Tomorrow\nread: false\ndelivered: apns\n---\n\nNothing is overdue.\n\n## Mail digest\n\n## Worth opening\n\nNothing.\n\n## Everything else\n\nTwenty-three threads, none with a link.\n');
  await writeFile(join(vault, '.log', 'mail-digest.json'),
    JSON.stringify({ ids: ['a:3'], text: '## Everything else\n\n- **[the Webber invoice](/mail#pane=a%3A3)** — filed.', covers: 1, written_at: '2026-09-28 18:07' }));
  const replaced = await archiveDigest(vault, { now: new Date('2026-09-28T18:08:00'), into: '2026-09-28-1800-brief.md' });
  const after = await readFile(join(vault, 'messages', '2026-09-28-1800-brief.md'), 'utf8');
  check('a digest the brief wrote itself does not block the linked one', replaced.archived === true && /\(\/mail#pane=a%3A3\)/.test(after), JSON.stringify(replaced));
  check('  ...it is replaced, not left beside it', !/none with a link/.test(after) && (after.match(/^## Mail digest$/gm) ?? []).length === 1, after.slice(-300));
  check('  ...and the brief\'s own words stay', after.includes('Nothing is overdue.'));

  /* THE MARKER, COPIED. 2026-09-29: "why was there no mail digest". The brief
     model, having read the night before's brief, wrote the heading and the
     hidden marker with nothing under them, and the marker check took that
     for a digest already attached. */
  await writeFile(join(vault, 'messages', '2026-09-29-1800-brief.md'),
    '---\ntype: message\nkind: brief\nat: 2026-09-29 18:00\ntitle: Tomorrow\nread: false\ndelivered: apns\n---\n\nNothing is due.\n\n## Mail digest\n<!-- mail-digest: attached by the service -->\n');
  await writeFile(join(vault, '.log', 'mail-digest.json'),
    JSON.stringify({ ids: ['a:4'], text: '## Everything else\n\n- **[the PowerCo bill](/mail#pane=a%3A4)** — filed.', covers: 1, written_at: '2026-09-29 18:11' }));
  const forged = await archiveDigest(vault, { now: new Date('2026-09-29T18:12:00'), into: '2026-09-29-1800-brief.md' });
  const f2 = await readFile(join(vault, 'messages', '2026-09-29-1800-brief.md'), 'utf8');
  check('a marker the brief copied, with nothing under it, does not pass for a digest',
        forged.archived === true && /\(\/mail#pane=a%3A4\)/.test(f2), JSON.stringify(forged));
  check('  ...and the result has one heading and one marker', (f2.match(/^## Mail digest$/gm) ?? []).length === 1
        && (f2.match(/mail-digest: attached/g) ?? []).length === 1, f2.slice(-260));
  await writeFile(join(vault, '.log', 'mail-digest.json'),
    JSON.stringify({ ids: ['a:5'], text: '## Everything else\n\n- more', covers: 1, written_at: '2026-09-29 18:12' }));
  const again = await archiveDigest(vault, { now: new Date('2026-09-29T18:13:00'), into: '2026-09-29-1800-brief.md' });
  check('  ...and the ledger, not the text, stops a second one', again.archived === false && /attached 2026-09-29/.test(again.why), JSON.stringify(again));
  await rm(vault, { recursive: true, force: true });
}

async function readArchivedOf(vault) {
  const { readArchived } = await import('./digestlist.mjs');
  return readArchived(vault);
}

console.log(`\n${pass} passed, ${fail} failed`);