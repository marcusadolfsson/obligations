/**
 * The reading list's one piece of state, and the matcher that reads it.
 *
 * Ignore Sender is the only control on the site that decides what Alex will
 * never be shown again, so the matcher has to be exact where exactness matters
 * (an address never drags its neighbours at the same domain) and broad where he
 * asked for breadth (`@domain` catches the whole platform).
 */
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isIgnored, addressOf, ignoredSenders, ignoreSender, unignoreSender, senderMatches, readAsNewsletter, readingSenders } from './reading.mjs';
import { writeFile, readFile, readdir } from 'node:fs/promises';

import { sanitizeHtml } from '../integrations/mail-cache.mjs';
let pass = 0, fail = 0;
const ok = (m) => { console.log(`  ok   ${m}`); pass++; };
const bad = (m, d) => { console.log(`  FAIL ${m}${d ? ' -> ' + d : ''}`); fail++; };
const check = (m, c, d) => (c ? ok(m) : bad(m, d));

console.log('Parsing a From header');
check('Name <addr> gives the address', addressOf('The Gazette <news@localpaper.example>') === 'news@localpaper.example');
check('a bare address passes through', addressOf('news@localpaper.example') === 'news@localpaper.example');
check('quoted names are stripped', addressOf('"Apple Developer" <dev@apple.com>') === 'dev@apple.com');
check('it is lower-cased, because Gmail matches that way',
      addressOf('News <NEWS@localpaper.example>') === 'news@localpaper.example');

console.log('\nMatching the ignore list');
const ignored = new Set(['alerts@bank.com', '@substack.com']);
check('an exact address matches', isIgnored('alerts@bank.com', ignored));
check('  ...case-insensitively', isIgnored('Alerts@Bank.com', ignored));
check('  ...and does NOT drag its neighbour at the same domain',
      !isIgnored('statements@bank.com', ignored));
check('a @domain entry catches every sender there',
      isIgnored('anyone@substack.com', ignored) && isIgnored('other@substack.com', ignored));
check('  ...but not a lookalike domain', !isIgnored('me@notsubstack.com', ignored));
check('an empty address is never ignored', !isIgnored('', ignored) && !isIgnored(null, ignored));

console.log('\nThe file');
{
  const vault = await mkdtemp(join(tmpdir(), 'reading-'));
  await mkdir(join(vault, 'integrations'), { recursive: true });
  check('no file means nothing ignored', (await ignoredSenders(vault)).size === 0);
}

console.log('\nThe button refuses junk before touching anything');
{
  const vault = await mkdtemp(join(tmpdir(), 'reading-'));
  for (const junk of ['', 'not an address', 'drop table', '<script>', 'a@b']) {
    let threw = false;
    try { await ignoreSender(vault, junk); } catch { threw = true; }
    check(`rejects ${JSON.stringify(junk)}`, threw);
  }
  check('  ...and wrote no file doing so',
        (await ignoredSenders(vault)).size === 0);
}

/* Silencing a whole organisation.
 *
 * Alex, 2026-09-08, in chat: "ignore future emails from
 * @charityflights.example". The chat cannot write that list — it is reserved to
 * the button on purpose — and it told him to press the button instead. The
 * button sent the SENDER'S ADDRESS, so it would have silenced one person and
 * left the rest of the domain arriving. `ignoreSender` had always accepted a
 * domain; nothing in the UI could ask for one, so the decision the rule
 * reserved to a button was one the button could not express. */
console.log('\nA whole domain, which is what he actually asked for');
{
  const vault = await mkdtemp(join(tmpdir(), 'reading-'));
  await mkdir(join(vault, 'integrations'), { recursive: true });
  await ignoreSender(vault, '@charityflights.example', { by: 'alex@rivera.example' }).catch(() => {});
  const set = await ignoredSenders(vault);
  check('the domain is written as its own key', set.has('@charityflights.example'), [...set].join(','));
  check('and any address at it is ignored',
        isIgnored('holly.dorsey@charityflights.example', set), 'a domain key must cover its addresses');
  check('someone at another domain is not',
        !isIgnored('holly@example.org', set));
  // The half that makes it a decision rather than an accident.
  await ignoreSender(vault, 'one.person@example.com', { by: 'alex@rivera.example' }).catch(() => {});
  const set2 = await ignoredSenders(vault);
  check('ignoring one person does NOT silence their domain',
        !isIgnored('someone.else@example.com', set2),
        'a single address must never widen to the whole organisation');
}

console.log('\nsanitizeHtml — a sender\'s markup, fit for a sandboxed frame');
{
  const dirty = '<div onclick="x()"><script>alert(1)</script><a href="javascript:evil()">a</a><img src="https://x/y.png" onerror="e()"><form action="/p"><input></form><iframe src="https://z"></iframe><meta http-equiv="refresh" content="0"><p style="color:red">ok</p></div>';
  const clean = sanitizeHtml(dirty);
  check('scripts, forms, frames and meta are gone', !/<script|<form|<input|<iframe|<meta/i.test(clean), clean);
  check('event handlers are gone', !/onclick|onerror/i.test(clean), clean);
  check('javascript: links are defused', !/javascript:/i.test(clean) && /href="#"/.test(clean), clean);
  check('images and inline styles survive — that is the newsletter', /<img src="https:\/\/x\/y\.png"/.test(clean) && /style="color:red"/.test(clean), clean);
}

console.log('\nreadAsNewsletter — his reading list, and what moves when it changes');
{
  const dir = await mkdtemp(join(tmpdir(), 'obligations-'));
  await mkdir(join(dir, 'integrations'), { recursive: true });
  await writeFile(join(dir, 'integrations', 'email-state.json'), JSON.stringify({ threads: [
    { thread_id: 'a', account: 'personal', conclusion: { tier: 'digest', who: 'weekly@bizweekly.example', title: 'Weekend edition' } },
    { thread_id: 'b', account: 'personal', conclusion: { tier: 'action', who: 'weekly@bizweekly.example', title: 'Renew your subscription' } },
    { thread_id: 'c', account: 'personal', conclusion: { tier: 'digest', who: 'alerts@flightaware.com', title: 'x' } },
  ] }));
  const r = await readAsNewsletter(dir, 'Weekly@bizweekly.example', { by: 'm@x', name: 'TBBJ' });
  const senders = await readingSenders(dir);
  check('the sender is on his list, lowercased, with who added it', senders['weekly@bizweekly.example']?.by === 'm@x' && senders['weekly@bizweekly.example']?.name === 'TBBJ');
  const st = JSON.parse(await readFile(join(dir, 'integrations', 'email-state.json'), 'utf8'));
  check('their digest item is reading now; the action item and other senders are untouched',
        r.retiered === 1 && st.threads[0].conclusion.tier === 'reading' && st.threads[1].conclusion.tier === 'action' && st.threads[2].conclusion.tier === 'digest');
  const back = await readAsNewsletter(dir, 'weekly@bizweekly.example', { remove: true });
  const st2 = JSON.parse(await readFile(join(dir, 'integrations', 'email-state.json'), 'utf8'));
  check('removing sends the reading item back to digest and drops the sender', back.retiered === 1 && st2.threads[0].conclusion.tier === 'digest' && !(await readingSenders(dir))['weekly@bizweekly.example']);
  let err = null; try { await readAsNewsletter(dir, 'not an address'); } catch (e) { err = e; }
  check('a bad address is refused', /address or @domain/.test(err?.message ?? ''));
  await readAsNewsletter(dir, '@bizweekly.example');
  check('an @domain lists the whole domain', !!(await readingSenders(dir))['@bizweekly.example']);
}

/* ------------------------------------------------------- the HTML cache */

/* Alex, 2026-09-19: "can we cache the html version too?" — asked because As
 * sent became the default view, so every open cost a Gmail call for the one
 * body deliberately never stored.
 *
 * The property that matters most here is the SEPARATION. `read()` is what
 * anything reading a thread for the agent calls, and it must keep returning
 * text and only text however much markup the cache holds — the argument in
 * mail-cache.mjs's header for keeping bodies at all depends on it.
 */
{
  console.log('\nthe html cache');
  const { cacheHtml, readHtml, read: readText, cacheThread } = await import('../integrations/mail-cache.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'obligations-htmlcache-'));
  process.env.OBLIGATIONS = dir;
  const shaped = {
    thread_id: 't1', account: 'personal', subject: 'Weekend edition',
    messages: [{ id: 'm1', from: 'a@b.com', text: 'the flattened text', html: '<p>the markup</p>' }],
  };
  await mkdir(join(dir, '.log', 'mail-cache', 'personal'), { recursive: true });
  // The text cache, as the nightly pass would leave it.
  await writeFile(join(dir, '.log', 'mail-cache', 'personal', 't1.json'),
                  JSON.stringify({ ...shaped, messages: [{ id: 'm1', from: 'a@b.com', text: 'the flattened text' }] }));
  await cacheHtml('personal', 't1', shaped, { vault: dir });

  const back = await readHtml(dir, 'personal', 't1');
  check('the html comes back from cache', back?.messages?.[0]?.html === '<p>the markup</p>');
  const asText = await readText(dir, 'personal', 't1');
  check('and read() — what the agent path uses — still has no markup in it',
        !!asText && !JSON.stringify(asText).includes('the markup'));
  check('  ...two files, so the separation is structural rather than a promise',
        (await readdir(join(dir, '.log', 'mail-cache', 'personal'))).sort().join(',') === 't1.html.json,t1.json');

  // A reply lands: the text cache gains a message, so the cached markup is a
  // conversation missing its newest line and must not be served.
  await writeFile(join(dir, '.log', 'mail-cache', 'personal', 't1.json'),
                  JSON.stringify({ ...shaped, messages: [{ id: 'm1', text: 'x' }, { id: 'm2', text: 'the reply' }] }));
  check('a thread that has gained a reply refuses the stale markup',
        (await readHtml(dir, 'personal', 't1')) === null);
  check('a thread that was never cached is a miss, not a crash',
        (await readHtml(dir, 'personal', 'nope')) === null);

  /* Bounded. HTML is 10-50x the text, so the store is capped per account and
     evicts by last use — unbounded it becomes a second copy of his Gmail. */
  const many = join(dir, '.log', 'mail-cache', 'work');
  await mkdir(many, { recursive: true });
  for (let i = 0; i < 405; i++) {
    await cacheHtml('work', `t${i}`, { messages: [{ id: `m${i}`, html: '<p>x</p>' }] }, { vault: dir });
  }
  const left = (await readdir(many)).filter((n) => n.endsWith('.html.json')).length;
  check('the html store stays capped', left <= 400, String(left));
}

/* IGNORING CLOSES WHAT IS OPEN WITH THEM. Alex, 2026-09-30: "yes adding
 * someone on ignore list closes tasks" — a Charity Flights mission ask sat
 * at high priority for two weeks after @charityflights.example was ignored. */
console.log('\nignoring a sender closes their open tasks');
{
  check('an address matches itself, a domain matches its people and subdomains',
        senderMatches('holly.dorsey@charityflights.example', '@charityflights.example')
        && senderMatches('"Holly" <holly@mail.charityflights.example>', '@charityflights.example')
        && senderMatches('holly@charityflights.example', 'holly@charityflights.example'));
  check('  ...and nothing else — not a lookalike domain, not a phone, not a name',
        !senderMatches('x@notcharityflights.example', '@charityflights.example') && !senderMatches('+17275550100', '@charityflights.example')
        && !senderMatches('Charity Flights', '@charityflights.example'));

  const { mkdtemp, mkdir, writeFile: wf, readFile: rf } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join: j } = await import('node:path');
  const { listOpen } = await import('./obligations.mjs');
  const vault = await mkdtemp(j(tmpdir(), 'obligations-ign-'));
  await mkdir(j(vault, 'integrations'), { recursive: true });
  const conc = (tid, who, title) => ({ thread_id: tid, account: 'personal', watermark: '2026-09-08 16:14', reviewed: '2026-09-08 16:20',
    conclusion: { open: true, tier: 'action', who, title, what: title, owed_by: 'me', since: '2026-09-08 16:14' } });
  await wf(j(vault, 'integrations', 'email-state.json'), JSON.stringify({ threads: [
    conc('t-vac', 'holly.dorsey@charityflights.example', 'Decide the CFN mission, Fairview GA-Bryce MS'),
    conc('t-other', 'someone@example.com', 'Answer someone else')] }));
  try { await ignoreSender(vault, '@charityflights.example', { by: 'test' }); } catch { /* no Gmail here: the sweep fails after the closes */ }
  const open = (await listOpen(vault)).map((o) => o.title);
  check('their open task closes when they are ignored', !open.some((t) => /CFN mission/.test(t)), JSON.stringify(open));
  check('  ...and nobody else\'s', open.includes('Answer someone else'), JSON.stringify(open));
  const entry = JSON.parse(await rf(j(vault, 'integrations', 'ignored-senders.json'), 'utf8')).senders['@charityflights.example'];
  check('  ...and the ignore entry remembers what it closed', JSON.stringify(entry?.closed) === '["mail:personal:t-vac"]', JSON.stringify(entry));
  const un = await unignoreSender(vault, '@charityflights.example');
  check('un-ignoring puts it back', un.reopened?.length === 1 && (await listOpen(vault)).some((o) => /CFN mission/.test(o.title)), JSON.stringify(un));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
