/**
 * What pays itself. His list, like the ignore list: a vendor (an address or a
 * whole @domain), optionally narrowed to account numbers, whose bills are on
 * autopay and so are never a task — unless the payment fails.
 *
 * Alex, 2026-09-30, of WXF6 ("Pay the Power Co bill (acct … 1234)"): "is
 * on autopay. I only want to be a task if autopay fails. How can we make that
 * systematic so we can apply to other vendors too." Until then autopay was a
 * string of one-off verdicts — Premier Aviation, every credit card, the ONE
 * COA ledger through PayPortal, the Bayport utility bill — each a sentence the
 * triage had to remember, and a new account at a known vendor was a task
 * every month until he said so again.
 *
 * Three readers, one list:
 *  - the mail differ flags a thread from a listed vendor (`signals.autopay`),
 *    so the triage files the statement with its amount instead of opening a
 *    task;
 *  - review.mjs closes any open bill from a listed vendor on every pass,
 *    unless the mail says the payment failed — the net under the triage;
 *  - the To Do pane's "On autopay" button and `deploy/autopay.mjs` add to it.
 *
 * Accounts: Power Co has three on one sender, and he named one. An entry
 * with `accounts` matches only a bill that names one of them (the last four
 * digits are enough); an entry without matches everything from that sender.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withRepoLock } from './lock.mjs';
import { localStamp } from './time.mjs';

export const FILE = ['integrations', 'autopay.json'];

/* A payment that did not happen. This is the one thing about an autopaid bill
   that needs him, so it is read generously — a false "failed" leaves a task
   he dismisses, a missed one leaves a service cut off. */
export const FAILED = /\b(declined|failed|failure|unsuccessful|unable to (process|complete|charge)|could not be (processed|completed|charged)|returned (payment|item)|insufficient|nsf|past[- ]due|overdue|late (fee|charge|notice)|disconnect\w*|suspen\w+|shut[- ]?off|payment (was )?not (received|processed)|update (your )?payment (method|information))\b/i;

export async function readAutopay(vault) {
  try {
    const d = JSON.parse(await readFile(join(vault, ...FILE), 'utf8'));
    return d && typeof d.vendors === 'object' && d.vendors ? d.vendors : {};
  } catch { return {}; }
}

const emailOf = (who) => {
  const m = String(who ?? '').match(/<([^>]+)>/);
  const e = String(m ? m[1] : who ?? '').trim().toLowerCase();
  return e.includes('@') ? e : null;
};

/** Does this sender fall under that key — the address, or anyone at the domain or a subdomain. */
export function senderIs(who, key) {
  const email = emailOf(who);
  if (!email) return false;
  const k = String(key ?? '').toLowerCase().trim();
  if (!k.startsWith('@')) return email === k;
  const host = email.split('@').pop(), dom = k.slice(1);
  return host === dom || host.endsWith('.' + dom);
}

/** The last digits of every account number the text names — "acct … 1234", "account 900000001234", "ending 9876". */
export function accountsIn(text) {
  const out = new Set();
  for (const m of String(text ?? '').matchAll(/\b(?:acct|account|a\/c|ending|ends? in)\b[^0-9]{0,12}([0-9][0-9 -]{2,})/gi)) {
    const digits = m[1].replace(/\D/g, '');
    if (digits.length >= 4) out.add(digits.slice(-4));
  }
  return [...out];
}

/**
 * The autopay entry covering this obligation, or null. `o` needs `who` and
 * the text (`title`, `what`) the account numbers are read from.
 */
export function accountOf(o) {
  /* THE BILL'S OWN ACCOUNT, not every number in it. The triage cross-refers:
     WXF6's text names the other two PowerCo accounts ("… nor the one ending
     9876"), so reading every number would let one account's entry cover
     another's bill. The title's, else the first the text names. */
  return accountsIn(o?.title)[0] ?? accountsIn(String(o?.what ?? '').split(/\n+UPDATE\b/)[0])[0] ?? null;
}

/* ONLY BILLS. A vendor on autopay still writes about other things — the ONE
   Springfield association sends its whole ledger through PayPortal AND its
   board notices from the same address — and an entry must never close "reply
   to the board" because the dues pay themselves. So: tagged #invoice, or a
   title that is about paying. */
const BILL = /\b(pay|paid|invoices?|bills?|billing|statements?|charges?|balance|payments?|autopay|auto-pay|premium|dues|renewal fee|amount due)\b/i;
export const isBill = (o) => (o?.tags ?? []).includes('invoice') || BILL.test(String(o?.title ?? ''));

export function autopayFor(o, vendors) {
  if (!isBill(o)) return null;
  for (const [key, v] of Object.entries(vendors ?? {})) {
    if (!senderIs(o?.who, key)) continue;
    const want = (v?.accounts ?? []).map((a) => String(a).replace(/\D/g, '').slice(-4)).filter(Boolean);
    if (!want.length) return { key, ...v };
    const acct = accountOf(o);
    if (acct && want.includes(acct)) return { key, ...v, account: acct };
  }
  return null;
}

/** Did the payment fail, by the mail's own words? Only the headline — an UPDATE log quotes old notices. */
export function paymentFailed(o) {
  const head = String(o?.what ?? '').split(/\n+UPDATE\b/)[0];
  return FAILED.test(`${o?.title ?? ''} ${head}`);
}

/**
 * Add a vendor, or an account to one. `key` is an address or @domain.
 * Idempotent; an account is added to the entry's list, and an entry that
 * already covers every account is left covering every account.
 */
export async function addAutopay(vault, key, { account = null, by = 'chat', name = null, note = null } = {}) {
  const k = String(key ?? '').toLowerCase().trim();
  if (!/^(@[a-z0-9.-]+\.[a-z]{2,}|[^\s@]+@[a-z0-9.-]+\.[a-z]{2,})$/.test(k)) throw new Error('not an address or @domain');
  const acct = account ? String(account).replace(/\D/g, '').slice(-4) : null;
  if (account && (!acct || acct.length < 4)) throw new Error('an account needs at least four digits');
  let entry;
  await withRepoLock(vault, async () => {
    const path = join(vault, ...FILE);
    let d;
    try { d = JSON.parse(await readFile(path, 'utf8')); } catch { d = null; }
    if (!d || typeof d !== 'object') d = { $comment: 'Vendors on autopay: their bills are never a task unless the payment fails. His list; written by the On autopay button and deploy/autopay.mjs. `accounts` (last four digits) narrows an entry to those accounts; without it, everything from the sender.', vendors: {} };
    d.vendors ??= {};
    const was = d.vendors[k];
    if (!was) {
      d.vendors[k] = { since: localStamp(), by, ...(name ? { name } : {}), ...(note ? { note } : {}), ...(acct ? { accounts: [acct] } : {}) };
    } else if (acct && Array.isArray(was.accounts) && !was.accounts.includes(acct)) {
      was.accounts.push(acct);
    }
    entry = { key: k, ...d.vendors[k] };
    await mkdir(join(vault, 'integrations'), { recursive: true });
    await writeFile(path, JSON.stringify(d, null, 2) + '\n');
  });
  return entry;
}

/**
 * Close every open bill the list now covers — not only the one he tapped.
 * The same test the review pass applies, so what closes here is exactly what
 * would have closed on the next pass; `by` is his name for the one he tapped
 * (`tapped`), agent:autopay for the rest.
 */
export async function closeCovered(vault, { by = 'agent:autopay', tapped = null } = {}) {
  const { listOpen, closeObligation } = await import('./obligations.mjs');
  const vendors = await readAutopay(vault);
  const closed = [];
  for (const o of await listOpen(vault).catch(() => [])) {
    if ((o.owed_by ?? 'me') === 'them') continue;
    const ap = autopayFor(o, vendors);
    if (!ap || paymentFailed(o)) continue;
    const which = `${ap.name ?? ap.key}${ap.account ? ` (account ending ${ap.account})` : ''}`;
    const r = await closeObligation(vault, o.id, o.id === tapped ? by : 'agent:autopay',
      `on autopay — ${which} pays itself; only a failed payment is a task`).catch((e) => ({ error: String(e?.message ?? e) }));
    if (!r?.error) closed.push({ id: o.id, code: o.code, title: o.title });
  }
  return closed;
}

/**
 * Take a vendor off the list — the Notes page's Remove. Bills it closed stay
 * closed: a close is a record of something that happened, and the next bill
 * from them is a task again, which is what taking it off means.
 */
export async function removeAutopay(vault, key) {
  const k = String(key ?? '').toLowerCase().trim();
  let removed = false;
  await withRepoLock(vault, async () => {
    const path = join(vault, ...FILE);
    let d; try { d = JSON.parse(await readFile(path, 'utf8')); } catch { return; }
    if (!d?.vendors?.[k]) return;
    delete d.vendors[k];
    await writeFile(path, JSON.stringify(d, null, 2) + '\n');
    removed = true;
  });
  return { key: k, removed };
}
