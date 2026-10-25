/**
 * autopay.mjs — his list of what pays itself. Alex, 2026-09-30, of WXF6,
 * a Power Co bill: "is on autopay. I only want to be a task if autopay
 * fails. How can we make that systematic so we can apply to other vendors too."
 */
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { senderIs, accountsIn, autopayFor, paymentFailed, addAutopay, closeCovered, readAutopay, removeAutopay } from './autopay.mjs';
import { listOpen } from './obligations.mjs';

let pass = 0, fail = 0;
const check = (m, c, d) => { if (c) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.log(`  FAIL ${m}${d ? ` -> ${d}` : ''}`); } };
const DUKE = 'powercopaperlessbilling@paperless.powerco.example';

console.log('who and which account');
check('a domain covers its senders and subdomains', senderIs(DUKE, '@powerco.example') && senderIs(`"PowerCo" <${DUKE}>`, '@powerco.example'));
check('  ...and not a lookalike', !senderIs('x@notpowerco.example', '@powerco.example'));
check('the account a bill names, in the shapes the triage writes',
      JSON.stringify(accountsIn('Pay the Power Co bill (acct … 1234)')) === '["1234"]'
      && accountsIn('account 900000001234: 105.32 USD').includes('1234') && accountsIn('the one ending 9876').includes('9876'));
const vendors = { [DUKE]: { since: '2026-09-30 12:00', accounts: ['1234'], name: 'Power Co' } };
const bill = (title, what = '') => ({ who: DUKE, owed_by: 'me', title, what });
check('a bill for the listed account is covered', autopayFor(bill('Pay the Power Co bill (acct … 1234)'), vendors)?.account === '1234');
check('  ...another account at the same vendor is not — PowerCo has three', !autopayFor(bill('Pay the Power Co bill', 'account 900000004321'), vendors));
check('  ...nor a bill that only MENTIONS the listed account while naming its own',
      !autopayFor(bill('Pay the Power Co bill (acct … 9876)', 'Not the same as account 900000001234.'), vendors));
check('only a bill: another task from the same sender is untouched',
      !autopayFor({ who: DUKE, owed_by: 'me', title: 'Answer PowerCo about the easement survey', what: 'account 900000001234' }, { [DUKE]: {} }));
check('  ...and an entry with no accounts covers every one', !!autopayFor(bill('Pay the Power Co bill', 'account 900000004321'), { [DUKE]: {} }));

console.log('\nthe one case that is his');
check('a failed payment is a task', paymentFailed(bill('Power Co: your automatic payment was declined')) && paymentFailed(bill('Past due notice')));
check('  ...a statement is not', !paymentFailed(bill('Pay the Power Co bill (acct … 1234)', 'Statement ready: 105.32 USD due 2026-10-21, AutoPay will draft')));
check('  ...and an old failure in the UPDATE log does not count', !paymentFailed(bill('Pay the bill', 'Statement ready.\nUPDATE 2026-09-01: last month the payment was declined')));

console.log('\nthe list, and closing what it covers');
{
  const vault = await mkdtemp(join(tmpdir(), 'obligations-ap-'));
  await mkdir(join(vault, 'integrations'), { recursive: true });
  const conc = (tid, who, title, what) => ({ thread_id: tid, account: 'personal', watermark: '2026-09-30 08:05', reviewed: '2026-09-30 08:10',
    conclusion: { open: true, tier: 'action', who, title, what, owed_by: 'me', since: '2026-09-30 08:05' } });
  await writeFile(join(vault, 'integrations', 'email-state.json'), JSON.stringify({ threads: [
    conc('t-1234', DUKE, 'Pay the Power Co bill (acct … 1234)', 'account 900000001234: 105.32 USD due 2026-10-21'),
    conc('t-7475', DUKE, 'Pay the Power Co bill', 'account 900000004321: 1,649.69 due 2026-10-01'),
    conc('t-fail', DUKE, 'Power Co payment declined (acct … 1234)', 'Your automatic payment for account ending 1234 was declined.')] }));
  const e = await addAutopay(vault, DUKE, { account: '900000001234', by: 'test', name: 'Power Co' });
  check('an account is stored as its last four digits', JSON.stringify(e.accounts) === '["1234"]', JSON.stringify(e));
  await addAutopay(vault, DUKE, { account: '1234', by: 'test' });
  check('  ...and adding it again changes nothing', JSON.stringify((await readAutopay(vault))[DUKE].accounts) === '["1234"]');
  const closed = await closeCovered(vault, { by: 'alex@rivera.example', tapped: 'mail:personal:t-1234' });
  const open = (await listOpen(vault)).map((o) => o.id);
  check('the covered bill closes', closed.some((c) => c.id === 'mail:personal:t-1234') && !open.includes('mail:personal:t-1234'), JSON.stringify(closed));
  check('  ...the other account stays a task', open.includes('mail:personal:t-7475'));
  check('  ...and so does the failed payment', open.includes('mail:personal:t-fail'));
  const off = await removeAutopay(vault, DUKE);
  check('Remove takes a vendor off the list', off.removed && !(await readAutopay(vault))[DUKE], JSON.stringify(off));
  check('  ...and removing one that is not there says so', (await removeAutopay(vault, DUKE)).removed === false);
  let err = null; try { await addAutopay(vault, 'not an address'); } catch (x) { err = x.message; }
  check('a key that is not an address or @domain is refused', /not an address/.test(err ?? ''));
  await rm(vault, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
