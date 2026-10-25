/**
 * The realtime gate: what may ring Alex's phone at three in the morning.
 *
 * Every failing case below is a way a stranger causes an interrupt he did not
 * approve. That is the whole reason this is a pure function with an exhaustive
 * test rather than a judgement call somewhere in a larger flow.
 *
 * The acceptance bar for the classifier is **zero false positives**. A miss
 * costs him a walk to his mail; a false positive costs the channel.
 */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPolicy, MAX_SENDERS } from './hook/policy.mjs';
import { classify, relayText, matchSender, address, senderDomain, FRESH_MS } from './hook/classify.mjs';

let pass = 0, fail = 0;
const ok = (m) => { console.log(`  ok   ${m}`); pass++; };
const bad = (m, d) => { console.log(`  FAIL ${m}${d ? ' -> ' + d : ''}`); fail++; };
const check = (m, c, d) => (c ? ok(m) : bad(m, d));

const SECTION = (rows, patterns = null, addrs = 'alex@rivera.example') => `# Email triage policy

## Realtime — what may ring the phone

Prose here is ignored.

### Senders

| sender domain | login domain | what it is | date ratified |
|---|---|---|---|
${rows}

### His addresses

\`\`\`
${addrs}
\`\`\`

### Subject patterns

\`\`\`
${patterns ?? '\\b(verification|security|login) code\\b\n\\b(verifierings|engångs)kod\\b'}
\`\`\`

### Vetoes

\`\`\`
List-Id present
subject matches: receipt|invoice|newsletter|digest|weekly
\`\`\`

## Something after
`;

async function policyFrom(md) {
  const dir = await mkdtemp(join(tmpdir(), 'pol-'));
  await mkdir(join(dir, 'rules'), { recursive: true });
  await writeFile(join(dir, 'rules', 'realtime-push.md'), md);
  return loadPolicy(dir);
}

const GOOD_ROWS = `| accounts.google.com | google.com | Google sign-in | 2026-08-30 |
| slack.com | slack.com | Slack magic code | 2026-08-30 |`;

const BLOCKED = (doms) => `### Blocklist

\`\`\`
${doms}
\`\`\`
`;

/* ------------------------------------------------------------------ policy */

console.log('Reading the ratified list');
{
  const p = await policyFrom(SECTION(GOOD_ROWS));
  check('two ratified senders', p.ok && p.senders.size === 2, [...p.senders.keys()].join(','));
  check('  ...with their login domains', p.senders.get('slack.com').login === 'slack.com');
  check('his address is read', p.addresses.includes('alex@rivera.example'));
  check('patterns compile', p.patterns.length === 2, String(p.patterns.length));
  check('the veto compiles', p.vetoSubject?.test('Your weekly digest') === true);
  check('a fingerprint is produced so an edit can be noticed', p.fingerprint.length === 16);
  check('no problems on a clean list', p.problems.length === 0, p.problems.join('; '));
}
{
  const p = await policyFrom(SECTION(''));
  check('an empty list is valid and inert, not an error', p.ok && p.senders.size === 0);
}
{
  // Unfinished rows must not ring the phone. The date is what says "ratified".
  const p = await policyFrom(SECTION(`| evil.com | evil.com | added without a date | |
${GOOD_ROWS}`));
  check('a row with no ratified date is refused', !p.senders.has('evil.com'),
        [...p.senders.keys()].join(','));
  check('  ...and named as a problem rather than dropped in silence',
        p.problems.some((x) => x.includes('evil.com')), p.problems.join('; '));
  check('  ...while the ratified rows still load', p.senders.size === 2);
}
{
  const p = await policyFrom(SECTION(GOOD_ROWS, '\\b(unclosed group\n\\bcode\\b'));
  check('a pattern that does not compile is skipped', p.patterns.length === 1);
  check('  ...and named', p.problems.some((x) => x.includes('unparseable pattern')));
}
{
  const many = Array.from({ length: MAX_SENDERS + 1 },
    (_, i) => `| s${i}.example.com | s${i}.example.com | x | 2026-08-30 |`).join('\n');
  const p = await policyFrom(SECTION(many));
  check('over the cap the WHOLE list is refused, not truncated',
        !p.ok && p.senders.size === 0,
        'truncating would silently choose which of his senders still work');
  check('  ...and says why', p.problems.some((x) => x.includes('cap')), p.problems.join('; '));
}
{
  const p = await policyFrom('# no realtime section here\n');
  check('a missing section is not a crash', !p.ok && p.senders.size === 0);
}

/* --------------------------------------------------------------- classifier */

const POLICY = await policyFrom(SECTION(GOOD_ROWS));
const now = Date.UTC(2026, 7, 30, 12, 0, 0);
const fresh = now - 60_000;

const mail = (over = {}) => ({
  'Authentication-Results': 'mx.google.com; dkim=pass; spf=pass; dmarc=pass header.from=accounts.google.com',
  From: 'Google <no-reply@accounts.google.com>',
  To: 'alex@rivera.example',
  Subject: 'Your Google verification code',
  ...over,
});
const run = (over, date = fresh) =>
  classify(mail(over), { internalDate: date, now, policy: POLICY });

console.log('\nThe one that should ring');
{
  const r = run({});
  check('a ratified, authenticated, fresh code', r.tier === 'code', r.reason);
  check('  ...naming the service', r.service === 'Google sign-in', r.service);
  check('  ...and the login domain for the autofill line', r.loginDomain === 'google.com');
}
check('a subdomain of a ratified sender matches',
      run({ From: 'Slack <no-reply@e.slack.com>',
            'Authentication-Results': 'dmarc=pass',
            Subject: 'Your Slack login code' }).tier === 'code');

console.log('\nEvery way a stranger must NOT ring it');
check('no Authentication-Results at all',
      run({ 'Authentication-Results': '' }).tier === 'none');
check('dmarc=fail',
      run({ 'Authentication-Results': 'spf=pass; dmarc=fail' }).tier === 'none');
check('dkim passes but dmarc does not',
      run({ 'Authentication-Results': 'dkim=pass; spf=pass' }).tier === 'none');
check('a near-miss of a ratified domain is refused even in open mode',
      run({ From: 'Google <no-reply@goog1e.com>',
            'Authentication-Results': 'dmarc=pass header.from=goog1e.com' }).tier === 'none',
      'registering the domain and passing DMARC on it is trivial');
check('  ...and says which listed domain it resembles',
      run({ From: 'Google <no-reply@goog1e.com>',
            'Authentication-Results': 'dmarc=pass' }).reason.includes('accounts.google.com'));
check('a genuinely unrelated unlisted sender is NOT caught by that',
      run({ From: 'security@github.com', 'Authentication-Results': 'dmarc=pass',
            Subject: 'Your GitHub verification code' }).tier === 'code',
      'the near-miss check must not become a second allowlist');
check('a blocklisted sender, whatever it matches',
      classify(mail({ From: 'noreply@spammy.example',
                      'Authentication-Results': 'dmarc=pass' }),
               { internalDate: fresh, now,
                 policy: { ...POLICY, blocked: new Set(['spammy.example']) } }).tier === 'none');
check('a mailing-list post quoting a code',
      run({ 'List-Id': '<dev.example.com>' }).tier === 'none');
check('marketing from a ratified sender',
      run({ Subject: 'Your weekly security code digest' }).tier === 'none',
      'the veto has to beat the pattern');
check('an auto-reply', run({ 'Auto-Submitted': 'auto-replied' }).tier === 'none');
check('addressed to a list he receives, not to him',
      run({ To: 'newsletters@rivera.example' }).tier === 'none');
check('a subject that is not code-shaped',
      run({ Subject: 'Your invoice is ready' }).tier === 'none');

console.log('\nThe sender list is a fast lane, not a gate');
{
  const unlisted = { From: 'security@github.com',
                     'Authentication-Results': 'dmarc=pass',
                     Subject: 'Your GitHub verification code' };
  const r = run(unlisted);
  check('an unratified sender still comes through', r.tier === 'code', r.reason);
  check('  ...marked unratified, so the caller can use the tighter budget',
        r.ratified === false);
  check('  ...and gets the plain relay form, since no login domain is known',
        r.loginDomain === null,
        'a domain-bound code naming the wrong domain silently never offers');
  check('a ratified sender is marked as such', run({}).ratified === true);

  // The lever if the open setting is ever abused.
  const strict = classify(mail(unlisted), { internalDate: fresh, now, policy: POLICY, strict: true });
  check('strict mode restores the sender table as a gate', strict.tier === 'none', strict.reason);
  check('  ...while ratified senders still pass under it',
        classify(mail(), { internalDate: fresh, now, policy: POLICY, strict: true }).tier === 'code');
}

console.log('\nFreshness');
check('45 minutes old does not ring', run({}, now - 45 * 60_000).tier === 'none',
      'this is what makes a Pub/Sub retry after an outage harmless');
check('  ...and says how stale', run({}, now - 45 * 60_000).reason.includes('minutes'));
check('just inside the window still rings', run({}, now - (FRESH_MS - 5_000)).tier === 'code');
// Called directly: run()'s default parameter would swallow an undefined and
// hand back a fresh timestamp, testing nothing.
check('a missing internalDate does not ring',
      classify(mail(), { now, policy: POLICY }).tier === 'none');
check('a non-numeric internalDate does not ring',
      classify(mail(), { internalDate: 'whenever', now, policy: POLICY }).tier === 'none');
check('a timestamp far in the future does not ring', run({}, now + 3600_000).tier === 'none');

console.log('\nSwedish, because he is on .se services');
check('engångskod matches',
      run({ Subject: 'Din engångskod är 483920' }).tier === 'code',
      'a monolingual pattern set would silently miss half his services');

console.log('\nAn empty policy rings for nothing');
{
  // With the sender table demoted, patterns are the gate. No patterns, no pushes.
  const inert = await policyFrom(SECTION('', ' '));
  check('no subject patterns means nothing pushes',
        classify(mail(), { internalDate: fresh, now, policy: inert }).tier === 'none',
        'patterns are the gate now that senders are not');
}

console.log('\nHelpers');
check('address strips the display name', address('Google <a@b.com>') === 'a@b.com');
check('senderDomain', senderDomain('Google <a@b.co.uk>') === 'b.co.uk');
check('matchSender walks up one label at a time',
      matchSender('e.mail.slack.com', POLICY.senders)?.domain === 'slack.com');
check('  ...and does not match an unrelated domain',
      matchSender('slack.com.evil.net', POLICY.senders) === null,
      'walking up must not let a suffix attack through');

console.log('\nThe relayed text');
check('both lines when the login domain is known',
      relayText('284913', 'google.com') === 'Your verification code is 284913\n\n@google.com #284913');
check('the plain form when it is not',
      relayText('284913', null) === 'Your verification code is 284913',
      'a domain-bound code naming the wrong domain silently never offers');
check('no code means it says so rather than inventing one',
      relayText(null, 'google.com').includes('in your mail'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
