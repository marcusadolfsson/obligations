/**
 * Handle resolution.
 *
 * The failing case here shipped: `who` is not always a bare handle — the triage
 * writes "Hank and +15552000006 (PHOA)" for a group — and stripping non-digits
 * from that produced a number belonging to someone else. A group thread was
 * labelled with a stranger's name, in the list whose entire job is telling
 * Alex who is waiting on him.
 */
import { matchKey, resolveHandle, loadContacts } from './contacts.mjs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const ok = (m) => { console.log(`  ok   ${m}`); pass++; };
const bad = (m, d) => { console.log(`  FAIL ${m}${d ? ' -> ' + d : ''}`); fail++; };
const check = (m, c, d) => (c ? ok(m) : bad(m, d));

const contacts = { index: {
  '5552000006': 'Ruth Ellis',
  '7275551234': 'Anna',
  '5552000007': 'Someone Swiss',
  'clara@rivera.example': 'Clara (mother)',
} };

console.log('Handles resolve');
check('a plain number', resolveHandle(contacts, '+17275551234') === 'Anna');
check('the same number written differently',
      resolveHandle(contacts, '+1 (727) 555-1234') === 'Anna');
check('with no country code', resolveHandle(contacts, '7275551234') === 'Anna');
check('an email, case-insensitively',
      resolveHandle(contacts, 'clara@rivera.example') === 'Clara (mother)');
check('an unknown number stays unresolved', resolveHandle(contacts, '+19999999999') === null);

console.log('\nStrings that merely contain a handle do NOT resolve');
check('a group description does not become one member',
      resolveHandle(contacts, 'Hank and +15552000006 (PHOA)') === null,
      String(resolveHandle(contacts, 'Hank and +15552000006 (PHOA)')));
check('  ...nor does prose with a number in it',
      resolveHandle(contacts, 'owes 5552000006 dollars') === null);
check('a name already resolved stays as it is',
      resolveHandle(contacts, 'Clara (mother)') === null,
      'null means "no lookup"; the caller keeps what it had');

console.log('\nEdges');
check('"me" is a role, not someone to look up', resolveHandle(contacts, 'me') === 'me',
      'an address book containing his own number must not rename him mid-thread');
check('empty is empty', matchKey('') === '' && resolveHandle(contacts, '') === null);
check('null does not throw', resolveHandle(contacts, null) === null);
check('a short number is not padded into a false match', matchKey('12345') === '');
check('no contacts file means no names, not a crash',
      resolveHandle({ index: {} }, '+17275551234') === null);

/* TWO ADDRESSES, ONE PERSON. Alex, 2026-09-21:
   "lena.ortiz@propmgmt.example is the same person as
   manager@harborview-condo.example." They share no domain and neither was in the
   Mac's address book, so nothing here could know it: a chase to one could not
   see a reply from the other. `handles:` in the person file is the claim. */
console.log('\nhandles a person file claims');
{
  const dir = await mkdtemp(join(tmpdir(), 'book-'));
  await mkdir(join(dir, 'people'), { recursive: true });
  await mkdir(join(dir, 'integrations'), { recursive: true });
  await writeFile(join(dir, 'integrations', 'contacts.json'),
    JSON.stringify({ index: { 'admin@harborview-condo.example': 'Kyle Porter' } }));
  await writeFile(join(dir, 'people', 'lena-ortiz.md'),
    '---\ntype: person\nname: Lena Ortiz\nhandles: manager@harborview-condo.example, lena.ortiz@propmgmt.example\n---\n\n# Lena\n');
  // A file with no handles, and the template, must contribute nothing.
  await writeFile(join(dir, 'people', 'someone.md'), '---\ntype: person\nname: Someone\n---\n');
  await writeFile(join(dir, 'people', '_template.md'),
    '---\ntype: person\nname:\nhandles:         # comma separated\n---\n');

  const book = await loadContacts(dir);
  check('both of her addresses resolve to her', resolveHandle(book, 'manager@harborview-condo.example') === 'Lena Ortiz'
        && resolveHandle(book, 'lena.ortiz@propmgmt.example') === 'Lena Ortiz', JSON.stringify(book.index));
  check('  the synced book is still there beside them',
        resolveHandle(book, 'admin@harborview-condo.example') === 'Kyle Porter');
  check('  a colleague at the same domain is NOT folded in — an alias is one address, never a domain',
        resolveHandle(book, 'engineer@harborview-condo.example') === null);
  check('  a person file with no handles adds nothing', !Object.values(book.index).includes('Someone'));
  check('  and the template is skipped rather than claiming its own placeholder',
        Object.keys(book.index).length === 3, JSON.stringify(book.index));

  /* The address book failing must not take his own aliases down with it: they
     do not live in the file that failed. */
  const noJson = await mkdtemp(join(tmpdir(), 'book2-'));
  await mkdir(join(noJson, 'people'), { recursive: true });
  await writeFile(join(noJson, 'people', 'k.md'),
    '---\ntype: person\nname: Lena Ortiz\nhandles: manager@harborview-condo.example\n---\n');
  check('his aliases survive an unreadable contacts.json',
        resolveHandle(await loadContacts(noJson), 'manager@harborview-condo.example') === 'Lena Ortiz');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
