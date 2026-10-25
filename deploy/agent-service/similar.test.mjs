/**
 * Two rows for one thing — and, mostly, the pairs that merely rhyme.
 *
 * Alex, 2026-09-18: "sometimes a manual reminder matches an existing todo in
 * the assistant. how can we get them linked?" He had said "Sales Tax" into his
 * phone that morning while the mail triage already held "File the August the state
 * sales and use tax return".
 *
 * The asymmetry is the whole design. A duplicate left in the list is visible
 * and annoying; a wrong merge hides one of two real debts behind the other and
 * nothing ever surfaces it again. So this proposes, never merges — and most of
 * these cases are the ones it must refuse.
 */
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { words, likeness, twinOf, twins } from './similar.mjs';
import { linkObligations } from './obligations.mjs';

let pass = 0, fail = 0;
const check = (what, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? ` -> ${detail}` : ''}`); }
};

const ob = (id, title, over = {}) => ({ id, title, owed_by: 'me', open: true, since: '2026-09-01 09:00', ...over });

console.log('what counts as the same thing');
{
  const sales = ob('todo:1', 'File the August the state sales and use tax return', { due: '2026-09-18' });
  const said = ob('apple:u2', 'Sales Tax', { due: '2026-09-18' });
  const t = twinOf(said, [sales, said]);
  check('the case he asked about: a two-word reminder and the real task',
        t?.id === 'todo:1', JSON.stringify(t));
  check('  ...and it says why, in words he wrote himself',
        /both say/.test(t.why.join(' ')) && /both due 2026-09-18/.test(t.why.join(' ')), t.why.join(' '));

  check('a longer title is not punished for being descriptive',
        likeness(said, sales).score >= 0.9, String(likeness(said, sales).score));
  check('plurals and possessives do not hide a match',
        words("Ruth's consent forms").has('ruth') && words('consent form').has('form'));
}

console.log('\nwhat it must refuse');
{
  const pair = (a, b, over = {}) => twinOf(ob('x', a, over), [ob('x', a, over), ob('y', b, over)]);
  // Every one of these came out of the first live run over his real list.
  check('two vendors doing the same job for the same aircraft',
        !pair('Aircraft hours: Northwind — N200BB, N300CC (2026-08)',
              'Aircraft hours: Pinewood Engines — N200BB, N300CC (2026-08)', { due: '2026-09-08' }),
        'they scored 0.98 on words alone');
  check('two repairs for one person at two properties',
        !pair('Reimburse Dana for the Birchwood dock power repairs',
              'Reimburse Dana for the Elmwood generator repairs', { who: 'Dana Rivera' }));
  check('two missions on the same programme',
        !pair('Decide the CFN mission, Bayport-Fairfield 9/18',
              'Decide the CFN mission, Fairview GA-Bryce MS 9/20'));
  check('but extra detail on one side is still the same thing',
        !!pair('Pay the Prime Store Card statement', 'Pay the October Prime Store Card statement'),
        'October is detail, not a different card');

  check('two things owed in opposite directions are never one thing',
        !twinOf(ob('a', 'Send Hank the PHOA numbers'),
                [ob('a', 'Send Hank the PHOA numbers'), ob('b', 'Send Hank the PHOA numbers', { owed_by: 'them' })]));
  check('a closed one is not a twin', !twinOf(ob('a', 'Pay the invoice'), [ob('a', 'Pay the invoice'), ob('b', 'Pay the invoice', { open: false })]));
  /* REVERSED 2026-09-20. This asserted that three byte-identical titles are
     "a series, not a duplicate", and the live data said otherwise: six
     identical "Download the corrected Fivefold K-1s" were the same debt six
     times, and the rule kept them apart for ever. A real series carries what
     distinguishes it — Crestline, Studio, MDX — and `distinguished()` already
     keeps those apart; three titles with nothing to tell them by are copies.
     The family refusal still stands below IDENTICAL (see "the same thing six
     times" below). */
  check('three identical titles are copies, and the nearest is proposed',
        !!twinOf(ob('a', 'Review the cabinetry quote'),
                 [ob('a', 'Review the cabinetry quote'), ob('b', 'Review the cabinetry quote'), ob('c', 'Review the cabinetry quote')]));
  check('nothing alike proposes nothing',
        !twinOf(ob('a', 'Pay the hangar insurance'), [ob('a', 'Pay the hangar insurance'), ob('b', 'Book the sitter for Friday')]));
  check('an empty title cannot match anything',
        !twinOf(ob('a', ''), [ob('a', ''), ob('b', '')]));
}

console.log('\none pair, once');
{
  const all = [ob('todo:1', 'File the August the state sales and use tax return', { due: '2026-09-18' }),
               ob('apple:u2', 'Sales Tax', { due: '2026-09-18' })];
  const t = twins(all);
  check('a pair is offered once, not from both ends', t.length === 1, JSON.stringify(t.map((x) => x.id)));
  check('  ...and the proposal names both sides', !!t[0].id && !!t[0].twin.id);
}

console.log('\nrecording the link');
{
  const vault = await mkdtemp(join(tmpdir(), 'obligations-link-'));
  await mkdir(join(vault, 'integrations'), { recursive: true });
  await mkdir(join(vault, '.log'), { recursive: true });
  // Two real sources, so the merge is exercised through listObligations rather
  // than a fixture of its own shape.
  await writeFile(join(vault, 'todo.md'),
    '# Todo\n\n## Now\n\n- [ ] File the August the state sales and use tax return !due:2026-09-18 !since:2026-09-02\n');
  await writeFile(join(vault, 'integrations', 'reminders-apple.json'), JSON.stringify({
    generated_at: '2026-09-18 09:00',
    reminders: [{ id: 'u2', list: 'Reminders', title: 'Sales Tax', due: '2026-09-18', created: '2026-09-18 07:53', completed: false }],
  }));
  const { listOpen } = await import('./obligations.mjs');
  const before = await listOpen(vault);
  check('both are on the list to begin with', before.length === 2, String(before.length));

  const todoId = before.find((o) => /August the state/.test(o.title ?? o.what)).id;
  const appleId = before.find((o) => /Sales Tax/.test(o.title ?? o.what)).id;
  const r = await linkObligations(vault, appleId, todoId, 'his phone said it twice');
  check('the older one is the parent, so the merged row keeps the day it started',
        r.id === todoId && r.merged === appleId, JSON.stringify(r));
  const after = await listOpen(vault);
  check('one row where there were two', after.length === 1, String(after.length));
  check('  ...evidenced by both sources, so closing it discharges both',
        (after[0].evidence ?? []).map((e) => e.source).sort().join(',') === 'apple,todo',
        JSON.stringify((after[0].evidence ?? []).map((e) => e.source)));
  const file = JSON.parse(await readFile(join(vault, 'integrations', 'obligation-state.json'), 'utf8'));
  check('the reason is written down in the obligation\'s own record, like every other merge', /said it twice/.test(JSON.stringify(file.links)), JSON.stringify(file.links));

  const refuses = async (label, a, b) => {
    try { await linkObligations(vault, a, b, 'x'); check(`refuses ${label}`, false, 'accepted'); }
    catch (e) { check(`refuses ${label}`, true, e.message); }
  };
  await refuses('linking something to itself', todoId, todoId);
  await refuses('an id that does not exist', todoId, 'todo:nope');
  // A chain would make the parent ambiguous — the loader keeps the last mapping
  // it reads, so a member of one merge joining another silently moves rows.
  await refuses('one that is already merged into something else', appleId, todoId);
}


/* IDENTICAL IS NOT A FAMILY. Review 2026-09-20: six identical "Download the
 * corrected Fivefold K-1s" and five identical "Answer Crestline Cabinetry on
 * the quote" — and neither twinOf nor twins proposed any of them, ever. Every
 * candidate tied at 1.0, so the refusal built for a family of similar things
 * fired on the one case that is not a family. The refusal designed to
 * prevent a wrong merge guaranteed exact copies were the only duplicates
 * never surfaced. */
console.log('\nthe same thing six times');
{
  const six = Array.from({ length: 6 }, (_, k) => ob(`k${k}`, 'Download the corrected Fivefold K-1s', { who: 'justis@co927e.example' }));
  check('twinOf proposes a copy when every candidate is the same words', !!twinOf(six[0], six) && twinOf(six[0], six).score >= 0.95, JSON.stringify(twinOf(six[0], six)));
  check('and twins() pairs them rather than skipping the whole set', twins(six).length >= 3, String(twins(six).length));
  /* The family refusal still stands below identical: two aircraft-hours
     items for two suppliers tie at ~0.8 and are two things. */
  const fam = [ob('a', 'Aircraft hours: Northwind'), ob('b', 'Aircraft hours: Pinewood Engines'), ob('c', 'Aircraft hours: Honeywell')];
  check('a tie below identical is still a family, still refused', twinOf(fam[0], fam) === null, JSON.stringify(twinOf(fam[0], fam)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
