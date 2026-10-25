/**
 * The push path end to end, with Gmail and the SMS channel stubbed.
 *
 * Everything real is real: the policy is parsed from rules/realtime-push.md, the
 * classifier is the classifier, the caps are the caps. Only the network is
 * faked — which means these tests fail if any of those change in a way that
 * would stop a code reaching his phone, or start letting one through that
 * should not.
 */
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorize, process as runPush, decodeEnvelope } from './route.mjs';

let pass = 0, fail = 0;
const check = (what, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? ` -> ${detail}` : ''}`); }
};

const NOW = Date.parse('2026-09-01T20:00:00Z');
const SECRET = 's3cret';
const CFG = { secret: SECRET, audience: 'aud', serviceAccount: 'sa@x.iam.gserviceaccount.com' };

/** A repo with the real rules file, so the real policy is exercised. */
async function sandbox() {
  const dir = await mkdtemp(join(tmpdir(), 'hook-'));
  await mkdir(join(dir, 'rules'), { recursive: true });
  await mkdir(join(dir, '.log'), { recursive: true });
  const real = new URL('../../../rules/realtime-push.md', import.meta.url);
  await writeFile(join(dir, 'rules', 'realtime-push.md'), await readFile(real, 'utf8'));
  return dir;
}

const headers = (over = {}) => ({
  From: 'Google <no-reply@accounts.google.com>',
  To: 'alex@rivera.example',
  Subject: 'Your verification code is 284913',
  'Authentication-Results': 'mx.google.com; dkim=pass; spf=pass; dmarc=pass',
  ...over,
});

function stubGmail(messages, opts = {}) {
  const advanced = [];
  return {
    advanced,
    since: async () => ({ ids: messages.map((m) => m.id), historyId: '999', ...opts.since }),
    metadata: async (_b, id) => messages.find((m) => m.id === id),
    advance: async (_b, _a, h) => { advanced.push(h); },
    bodies: [],
    body: async function (_b, id) {
      this.bodies.push(id);
      return opts.body ?? { text: '' };
    },
  };
}

const message = (id, over = {}) => ({
  id, threadId: `t${id}`, internalDate: NOW - 60_000, labelIds: ['INBOX'],
  headers: headers(over),
});

function stubNotify() {
  const sent = [];
  const fn = async (m) => { sent.push(m); return { channel: m.channel, ok: true }; };
  fn.sent = sent;
  return fn;
}

const spoolOf = async (dir) => {
  try {
    return (await readFile(join(dir, '.log', 'email-pushes.jsonl'), 'utf8'))
      .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
};

console.log('Authorisation, before anything else runs');
{
  const url = (p) => new URL(`http://x${p}`);
  const okVerify = async () => ({});
  const req = { headers: { authorization: 'Bearer t' } };

  let r = await authorize(req, url(`/hooks/gmail/${SECRET}`), CFG, { verifyPushToken: okVerify });
  check('the right secret and a good token is allowed', r.ok === true, JSON.stringify(r));

  r = await authorize(req, url('/hooks/gmail/wrong'), CFG, { verifyPushToken: okVerify });
  check('a wrong path secret is 404, not 401', r.status === 404, JSON.stringify(r));

  r = await authorize(req, url(`/hooks/gmail/${SECRET}`), CFG, {
    verifyPushToken: async () => { throw new Error('signature does not verify'); } });
  check('a bad token is 401', r.status === 401, JSON.stringify(r));

  r = await authorize({ headers: {} }, url(`/hooks/gmail/${SECRET}`), CFG,
                      { verifyPushToken: async (t) => { if (!t) throw new Error('no bearer token'); } });
  check('no Authorization header is 401', r.status === 401, JSON.stringify(r));

  r = await authorize(req, url(`/hooks/gmail/${SECRET}`), { ...CFG, secret: '' },
                      { verifyPushToken: okVerify });
  check('an unconfigured endpoint refuses rather than opening', r.status === 503, JSON.stringify(r));
}

console.log('\nReading the envelope');
{
  const data = Buffer.from(JSON.stringify({ emailAddress: 'a@b.c', historyId: 42 })).toString('base64');
  const e = decodeEnvelope({ message: { data, messageId: 'p1' } });
  check('a Pub/Sub envelope decodes', e.historyId === '42' && e.pubsubMessageId === 'p1');
  check('junk decodes to null rather than throwing', decodeEnvelope({}) === null);
  check('a non-JSON payload decodes to null',
        decodeEnvelope({ message: { data: 'bm90anNvbg==' } }) === null);
}

console.log('\nThe whole path, with the real policy and classifier');
{
  const dir = await sandbox();
  const notify = stubNotify();
  const g = stubGmail([message('m1')]);

  const out = await runPush(dir, { deps: { gmail: g, notify, now: () => NOW } });
  check('a fresh, DMARC-passing code is pushed', out.pushed === 1, JSON.stringify(out));
  check('  ...over SMS, because that is the only channel iOS autofills from',
        notify.sent[0]?.channel === 'sms');
  check('  ...carrying the code', /284913/.test(notify.sent[0]?.body ?? ''));
  check('  ...with no title, which can stop autofill matching',
        notify.sent[0]?.title === '');
  check('the cursor advances only after the work', g.advanced[0] === '999');
  check('no body was fetched, because the subject had the code', g.bodies.length === 0,
        'a body request that never had to happen is one more thing that can fail');

  const spool = await spoolOf(dir);
  check('one spool line is written for the dispatcher', spool.length === 1);
  check('  ...recording how it was delivered', spool[0].delivered === 'sms' && spool[0].ok);
  // The whole reason the spool exists in this shape.
  check('  ...and NEVER the code itself',
        !JSON.stringify(spool[0]).includes('284913'), JSON.stringify(spool[0]));
  check('  ...nor the subject, which is where the code was',
        !('subject' in spool[0]));
}

console.log('\nThe code in the body, which is where it usually is');
{
  // ForeFlight's real shape: a code-shaped subject with no code in it, and the
  // code itself in the body.
  const dir = await sandbox();
  const notify = stubNotify();
  const g = stubGmail([message('m1', { Subject: 'Your ForeFlight Verification Code' })],
                      { body: { text: 'Enter your verification code.\nA6BX6M\n' } });

  const out = await runPush(dir, { deps: { gmail: g, notify, now: () => NOW } });
  check('the push still happens', out.pushed === 1, JSON.stringify(out));
  check('  ...and the body was fetched exactly once', g.bodies.length === 1);
  check('  ...carrying the code from the body', /A6BX6M/.test(notify.sent[0]?.body ?? ''),
        notify.sent[0]?.body);

  const spool = await spoolOf(dir);
  check('  ...and the spool records where it came from, not what it was',
        spool[0].code_from === 'body' && !JSON.stringify(spool[0]).includes('A6BX6M'),
        JSON.stringify(spool[0]));
}

{
  // No code anywhere. The relay must say one arrived rather than invent one.
  const dir = await sandbox();
  const notify = stubNotify();
  const g = stubGmail([message('m1', { Subject: 'Your verification code' })],
                      { body: { text: 'Click the button below to sign in.' } });
  await runPush(dir, { deps: { gmail: g, notify, now: () => NOW } });
  check('with no code anywhere, it says one arrived rather than inventing it',
        /is in your mail/.test(notify.sent[0]?.body ?? ''), notify.sent[0]?.body);
}

console.log('\nWhat must not push');
{
  const cases = [
    ['dmarc did not pass', { 'Authentication-Results': 'dmarc=fail' }],
    ['no Authentication-Results at all', { 'Authentication-Results': undefined }],
    ['a mailing list post quoting a code', { 'List-Id': '<list.example.com>' }],
    ['an auto-reply', { 'Auto-Submitted': 'auto-replied' }],
    ['not addressed to him', { To: 'someone-else@example.com' }],
    ['a subject that is not a code', { Subject: 'Your monthly statement' }],
  ];
  for (const [what, over] of cases) {
    const dir = await sandbox();
    const notify = stubNotify();
    const g = stubGmail([message('m1', over)]);
    await runPush(dir, { deps: { gmail: g, notify, now: () => NOW } });
    check(what, notify.sent.length === 0, `pushed anyway: ${JSON.stringify(notify.sent[0])}`);
    check(`  ...and its body was never fetched (${what})`, g.bodies.length === 0,
          'classification is on headers alone; a refused message is never opened');
  }

  // Freshness, which is what makes a Pub/Sub retry after an outage harmless.
  const dir = await sandbox();
  const notify = stubNotify();
  const old = { ...message('m1'), internalDate: NOW - 45 * 60_000 };
  await runPush(dir, { deps: { gmail: stubGmail([old]), notify, now: () => NOW } });
  check('a 45-minute-old code is not pushed', notify.sent.length === 0);
}

console.log('\nThe same message is never pushed twice');
{
  const dir = await sandbox();
  const notify = stubNotify();
  const g = stubGmail([message('m1')]);
  await runPush(dir, { deps: { gmail: g, notify, now: () => NOW } });
  await runPush(dir, { deps: { gmail: g, notify, now: () => NOW + 1000 } });
  check('a redelivered push does not send the code again', notify.sent.length === 1,
        `${notify.sent.length} sends — this is the failure that made him distrust it`);
}

console.log('\nA burst says so once, then goes quiet');
{
  const dir = await sandbox();
  const notify = stubNotify();
  // Distinct senders and ids so only the global cap bites. The clock advances
  // six minutes a round to clear the per-sender window, and each message is
  // fresh AT THAT MOMENT — otherwise the freshness rule refuses them from the
  // third round on and the caps are never reached at all.
  for (let i = 0; i < 9; i++) {
    const at = NOW + i * 6 * 60_000;
    const m = { ...message(`b${i}`, { From: `no-reply@svc${i}.com` }), internalDate: at - 30_000 };
    await runPush(dir, { deps: { gmail: stubGmail([m]), notify, now: () => at } });
  }
  const sms = notify.sent.filter((m) => m.channel === 'sms');
  const alerts = notify.sent.filter((m) => m.channel === 'ntfy');

  // Three, not six. The ratified sender table in rules/realtime-push.md is
  // empty, so every sender is unratified and UNRATIFIED_HOUR (3) bites before
  // GLOBAL_HOUR (6). That is the real configuration today, and pinning it here
  // means the effective ceiling is a stated fact rather than a surprise on the
  // night someone finds out. Ratifying a sender is what buys the looser budget.
  check('pushes stop at the tighter unratified ceiling', sms.length === 3,
        `${sms.length} codes sent`);
  check('  ...and exactly one warning goes out', alerts.length === 1, `${alerts.length} warnings`);
  check('  ...saying someone may be signing in as him',
        /trying to sign in/.test(alerts[0]?.body ?? ''), alerts[0]?.body);
  check('  ...on the notification channel, not the code channel',
        alerts[0]?.channel === 'ntfy');
}

console.log('\nBroken plumbing is reported, never silently nothing');
{
  const dir = await sandbox();
  const notify = stubNotify();
  const unarmed = { since: async () => ({ ids: [], unarmed: true }), metadata: async () => null,
                    advance: async () => {} };
  let out = await runPush(dir, { deps: { gmail: unarmed, notify, now: () => NOW } });
  check('an unarmed watch is named', /not armed/.test(out.errors.join(' ')), out.errors);

  const stale = { since: async () => ({ ids: [], stale: true }), metadata: async () => null,
                  advance: async () => {} };
  out = await runPush(dir, { deps: { gmail: stale, notify, now: () => NOW } });
  check('a cursor older than Gmail retains is named',
        /older than Gmail retains/.test(out.errors.join(' ')), out.errors);

  const broken = { since: async () => ({ ids: ['m1'], historyId: '5' }),
                   metadata: async () => { throw new Error('429 rate limited'); },
                   advance: async () => {} };
  out = await runPush(dir, { deps: { gmail: broken, notify, now: () => NOW } });
  check('a failed fetch does not take the run down', out.errors.length === 1, out.errors);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
