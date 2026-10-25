/**
 * The brief auditor's arithmetic: the two failures of 2026-09-07 must be
 * catchable, and a true sentence must not be flagged.
 */
import { parseMessage, dateClaims, sentClaims } from '../brief-audit.mjs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OBLIGATIONS = process.env.OBLIGATIONS ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..');

let pass = 0, fail = 0;
const check = (m, cond, detail) => {
  if (cond) { console.log(`  ok   ${m}`); pass++; }
  else { console.log(`  FAIL ${m}${detail ? '\n         ' + detail : ''}`); fail++; }
};

console.log('parseMessage');
{
  const { meta, body } = parseMessage('---\nkind: brief\nat: 2026-09-07 18:05\ntitle: X\n---\n\nBody here.\n');
  check('frontmatter and body split', meta.kind === 'brief' && meta.at === '2026-09-07 18:05' && body.trim() === 'Body here.');
  check('a file with no frontmatter is all body', parseMessage('plain').body === 'plain');
}

console.log('\ndateClaims — the failure of 2026-09-07 17:10');
{
  // Written on the 7th, calling the 7th "tomorrow" and quoting the 6th.
  const bad = dateClaims('Personal tax package — tomorrow, 2026-09-07. Alex, 2026-09-06: "top priority".', '2026-09-07 17:10');
  check('"tomorrow, <today>" is caught', bad.some((f) => f.said === '2026-09-07' && f.should === '2026-09-08'), JSON.stringify(bad));
  const good = dateClaims('Personal tax package — tomorrow, 2026-09-08. Alex, 2026-09-07: "top priority".', '2026-09-07 17:10');
  check('the corrected sentence is clean', good.length === 0, JSON.stringify(good));
  check('"today, <the day itself>" passes', dateClaims('Due today, 2026-09-07.', '2026-09-07 07:00').length === 0);
  check('"yesterday" a day out is caught', dateClaims('Yesterday, 2026-09-01, he said so.', '2026-09-07 07:00').length === 1);
  check('a quote attributed to a future day is caught', dateClaims('Alex, 2026-09-09: "do it".', '2026-09-07 07:00').some((f) => /future/.test(f.why)));
  check('a weekday that is not that date is caught', dateClaims('On Monday 2026-09-12 the vote closes.', '2026-09-07 07:00').some((f) => f.should === 'saturday'), JSON.stringify(dateClaims('On Monday 2026-09-12 the vote closes.', '2026-09-07 07:00')));
  check('the right weekday passes', dateClaims('On Friday 2026-09-11 the vote closes.', '2026-09-07 07:00').length === 0);
  check('a quoted "today" — the word being reported, not used — passes (2026-10-05)',
        dateClaims('the headline said he wanted the meeting "today", which meant 2026-10-03 when it was written', '2026-10-05 07:00').length === 0);
  check('  but an unquoted one beside the wrong date is still caught',
        dateClaims('he wants the meeting today, which is 2026-10-03', '2026-10-05 07:00').length === 1);
  check('an undated sentence is not guessed at', dateClaims('Send it tomorrow.', '2026-09-07 07:00').length === 0);
}

console.log('\nshapeFindings — the brief\'s shape, 2026-10-07');
{
  const { shapeFindings, BRIEF_WORDS } = await import('../brief-audit.mjs');
  const twice = 'Merged into [the drawings](/todo#pane=todo%3A0f4d). Later: [send them](/todo#pane=todo%3A0f4d).';
  check('a to-do linked twice is a REPEAT', shapeFindings(twice).some((f) => f.kind === 'REPEAT' && f.said === 'linked 2 times'));
  check('one linked once is not', shapeFindings('[the drawings](/todo#pane=todo%3A0f4d)').length === 0);
  const digest = '[x](/todo#pane=a)\n\n## Mail digest\n[x](/todo#pane=a)';
  check('the mail digest under the brief is not counted', shapeFindings(digest).length === 0);
  const long = Array.from({ length: BRIEF_WORDS + 50 }, () => 'word').join(' ');
  check('over the budget is LONG', shapeFindings(long).some((f) => f.kind === 'LONG'));
  check('link targets do not count as words', shapeFindings(`[a](/todo#pane=${'x'.repeat(5000)})`).length === 0);
}

console.log('\nsentClaims — the failure of 2026-09-07 18:45');
{
  const c = sentClaims('A follow-up went out on 2026-09-07 at 18:04 asking AirCover to confirm. He replied to them.');
  check('a dated send claim is picked up with its stamp', c.some((x) => x.date === '2026-09-07' && x.time === '18:04'), JSON.stringify(c));
  check('a sentence that says it is a draft is not a send claim',
        sentClaims('A chase is drafted and waiting on /outbox since 18:04; nothing was sent.').length === 0);
  check('"never sent" is not a send claim', sentClaims('The approved text never sent.').length === 0);
}

/* A brief may not explain an open obligation by inventing a machine failure.
 *
 * The 18:00 brief of 2026-09-08 said "the mail pipeline never saw it. The
 * thread left the extract before the mail job could judge it
 * (integrations/gmail-escaped.json)". That thread had been judged at 11:24
 * that morning, was in the current extract, and was in no escaped file. It
 * read as a diagnosis and cited a real file by name, so Alex asked why the
 * system could not self-cure — when what needed curing was the sentence.
 *
 * This runs against the live brief and the live escaped file, on purpose: the
 * bug was a disagreement between a brief and a file on disk, and a fixture
 * cannot disagree with anything. */
console.log('\nESCAPED — the fiction of 2026-09-08 18:00');
{
  const { auditBrief } = await import('../brief-audit.mjs');
  const { readdir } = await import('node:fs/promises');
  const files = (await readdir(join(OBLIGATIONS, 'messages'))).filter((f) => /-brief\.md$/.test(f)).sort();
  // A fresh install has no briefs yet; there is nothing live to disagree with.
  if (!files.length) console.log('  skip no briefs on disk yet');
  else {
  let checked = 0, wrong = 0;
  for (const f of files.slice(-12)) {
    const r = await auditBrief(OBLIGATIONS, join('messages', f));
    checked++;
    wrong += r.findings.filter((x) => x.kind === 'ESCAPED').length;
  }
  check(`the check runs over the last ${checked} briefs`, checked > 0);
  // Not "zero findings" — the brief that failed is in git and will keep
  // failing, which is right. What must hold is that the check can tell the
  // difference, so it is asserted against a brief written for the purpose.
  const clean = await auditBrief(OBLIGATIONS, join('messages', files[files.length - 1]));
  check('a finding names the file it should have appeared in',
        clean.findings.every((x) => x.kind !== 'ESCAPED' || /gmail-escaped/.test(x.should)));
  check('and says plainly that the pipeline did see it',
        clean.findings.every((x) => x.kind !== 'ESCAPED' || /did see it/.test(x.why)));
  console.log(`  note ${wrong} escape claim(s) across the last ${checked} briefs are unsupported`);
  }
}

/* JARGON. Alex, 2026-09-08: "It feels very code like. Can we drop references
 * to Mjs files etc." The distinction that matters is whose file it is: the
 * repo citing its own plumbing is noise, a reminder of his that names a
 * script is content. */
console.log('\nJARGON — the brief talking about itself');
{
  const { auditBrief } = await import('../brief-audit.mjs');
  const { writeFile, mkdtemp, mkdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const home = await mkdtemp(join(tmpdir(), 'obligations-jargon-'));
  await mkdir(join(home, 'messages'), { recursive: true });
  const audit = async (body) => {
    await writeFile(join(home, 'messages', 'x-brief.md'),
      `---\ntype: message\nkind: brief\nat: 2026-09-08 18:00\ntitle: t\nread: false\n---\n\n${body}\n`);
    const r = await auditBrief(home, join('messages', 'x-brief.md'));
    return r.findings.filter((f) => f.kind === 'JARGON');
  };
  check('a script of its own is caught', (await audit('conflicts.mjs found a clash.')).length === 1);
  check('a state file of its own is caught',
        (await audit('It left before judging (integrations/gmail-escaped.json).')).length === 1);
  check('an internal field name is caught', (await audit('Carl is still `needsAction`.')).length === 1);
  check('a bare thread path is caught', (await audit('See /thread/personal/19b0f4474a7446f3 for it.')).length === 1);
  check('the same path as a labelled link is fine',
        (await audit('See [the Noah thread](/thread/personal/19b0f4474a7446f3).')).length === 0);
  // The one that must NOT fire: his own reminder names a script.
  check("a reminder of his that names a script is content, not jargon",
        (await audit('Next is 09-20, the login.sh re-run before the token expires.')).length === 0);
  check('an amount in backticks is not a field name', (await audit('JLA came down to `$38K`.')).length === 0);
  check('a tail number in backticks is not a field name', (await audit('The `N200BB` hours are in.')).length === 0);
  check('plain prose is clean', (await audit('Vendorco answered at 08:23. Both top items are out.')).length === 0);
}

/* Which link. Alex, 2026-09-17: "the brief needs to link to the to-do if
 * there is one, to the mail thread if not to-do related." The thread is where
 * the words are; the to-do page is where he can close it, move its date or
 * draft the reply. */
console.log('\nLINK — the to-do first, the thread second');
{
  const { auditBrief } = await import('../brief-audit.mjs');
  const { writeFile, mkdtemp, mkdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const home = await mkdtemp(join(tmpdir(), 'obligations-link-'));
  await mkdir(join(home, 'messages'), { recursive: true });
  await mkdir(join(home, 'integrations'), { recursive: true });
  // One open obligation, from a mail thread, so the two links both exist.
  await writeFile(join(home, 'integrations', 'email-state.json'), JSON.stringify({ threads: [
    { thread_id: '1a0a28b6586eafb3', account: 'work', watermark: '2026-09-16 10:00', reviewed: '2026-09-16 10:00',
      conclusion: { open: true, tier: 'action', title: 'Pay or route the Forno auction invoice', since: '2026-09-16 10:00' } },
    /* Closed, and still a real obligation with a page. A brief's "closed
       today" section is instructed to link each item it names. */
    { thread_id: 'c10sed', account: 'work', watermark: '2026-09-16 10:00', reviewed: '2026-09-17 06:00',
      conclusion: { open: false, tier: 'action', title: 'The Citi overdraft', since: '2026-09-16 10:00',
                    closed_at: '2026-09-17 06:00', closed_by: 'alex@example.com' } },
    /* A digest receipt: judged, so it IS an obligation record, and never open.
       The mail digest appended to every brief links dozens of these. */
    { thread_id: 'd16e57', account: 'personal', watermark: '2026-09-21 20:00', reviewed: '2026-09-21 20:05',
      conclusion: { open: false, tier: 'digest', title: 'Power Co mid-cycle usage alert', since: '2026-09-21 20:00' } },
  ] }));
  const audit = async (body, kind) => {
    await writeFile(join(home, 'messages', 'x-brief.md'),
      `---\ntype: message\nkind: brief\nat: 2026-09-17 07:00\ntitle: t\nread: false\n---\n\n${body}\n`);
    const r = await auditBrief(home, join('messages', 'x-brief.md'));
    return r.findings.filter((f) => f.kind === kind);
  };
  const TASK = '/todo#pane=mail%3Awork%3A1a0a28b6586eafb3';
  check('linking the thread for something that is an open to-do is caught',
        (await audit('[The Forno invoice](/thread/work/1a0a28b6586eafb3) is $4,000.', 'LINK')).length === 1);
  check('  ...and it says which link to use instead',
        /todo#pane=/.test((await audit('[x](/thread/work/1a0a28b6586eafb3) is due.', 'LINK'))[0]?.should ?? ''));
  check('linking the to-do is clean', (await audit(`[The Forno invoice](${TASK}) is $4,000.`, 'LINK')).length === 0);
  check('a thread that is NOT an open to-do may be linked as a thread',
        (await audit('[A newsletter](/thread/personal/19b0f4474a7446f3) is worth reading.', 'LINK')).length === 0);
  /* THE DIGEST LINKS THREADS, AND IS RIGHT TO. Alex, 2026-09-22, of
     "Audit: 40 unsupported claims in the morning brief": twenty were this rule
     telling him to link digest receipts to a to-do page. A receipt is judged,
     so it has an obligation record — with open:false. The case above used a
     thread that was not in the record at all, which is why it never caught it. */
  check('a judged, never-open digest receipt linked as a thread is clean',
        (await audit('- **Power Co usage alert** — informational. **[open](/thread/personal/d16e57)**', 'LINK')).length === 0);

  /* ESCAPED IS CHECKED WHERE IT IS CLAIMED. The same brief truthfully said one
     thread had left the extract; because the word appeared anywhere, every
     link in the brief — the digest's twenty included — was held to it. */
  const escapeBody = 'One thread from yesterday could not be judged — it left the extract unread.\n\n'
    + '## Mail digest\n\n- **Power Co** — informational. **[open](/thread/personal/d16e57)**';
  check('an escape claim does not reach links in other paragraphs',
        (await audit(escapeBody, 'ESCAPED')).length === 0);
  check('  but a judged thread named IN the escape claim is still caught',
        (await audit('The [Forno thread](/thread/work/1a0a28b6586eafb3) left the extract before it was judged.', 'ESCAPED')).length === 1);
  /* A CLOSED OBLIGATION IS STILL A REAL ONE. Alex, 2026-09-21, of a note
   * headed "9 unsupported claims": every one was a link in the brief's own
   * "Closed since 07:00" section, which CLAUDE.md tells it to write and to
   * link. The To Do page grew a Closed view the day before, so those links
   * work. Nine false positives in one note is how a channel stops being read. */
  check('linking something CLOSED is clean — it has a page, and closed-today is a section briefs write',
        (await audit('[The Citi overdraft](/todo#pane=mail%3Awork%3Ac10sed) — transferred by hand.', 'TASK')).length === 0);
  check('  ...and quoting its id is clean too',
        (await audit('Closed: `mail:work:c10sed`.', 'TASK')).length === 0);
  check('a to-do link to an id no obligation has is still caught',
        (await audit('[Gone](/todo#pane=mail%3Awork%3Adeadbeef) is done.', 'TASK')).length === 1);
  check('  ...and says what is actually wrong with it',
        /no obligation has that id/.test((await audit('[Gone](/todo#pane=mail%3Awork%3Adeadbeef) is done.', 'TASK'))[0]?.why ?? ''));
  check('a bare to-do path is caught, like a bare thread path',
        (await audit(`See ${TASK} for it.`, 'JARGON')).length === 1);
  check('and the same path as a labelled link is fine',
        (await audit(`See [the invoice](${TASK}) for it.`, 'JARGON')).length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
