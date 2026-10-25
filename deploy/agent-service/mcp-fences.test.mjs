/**
 * The Gmail fences.
 *
 * Under `gmail.modify` the deny list is what stands between a prompt injection
 * in an email body and a mail going out as Alex. A deny list that has quietly
 * stopped matching the tool names looks exactly like one that works — so the
 * failing cases here matter more than the passing one.
 */
import { checkFences, MUST_DENY, MUST_NOT_BE_ALLOWED } from '../mcp-fences.mjs';

let pass = 0, fail = 0;
const ok = (m) => { console.log(`  ok   ${m}`); pass++; };
const bad = (m, d) => { console.log(`  FAIL ${m}${d ? ' -> ' + d : ''}`); fail++; };
const check = (m, c, d) => (c ? ok(m) : bad(m, d));

// What gmail.modify actually registers, from the published bundle.
const REGISTERED = [
  'read_email', 'search_emails', 'get_thread', 'list_inbox_threads',
  'get_inbox_with_threads', 'download_email', 'download_attachment',
  'list_email_labels', 'list_drafts', 'get_draft',
  'modify_email', 'modify_thread', 'batch_modify_emails',
  'draft_email', 'update_draft', 'delete_draft',
  'send_email', 'send_draft', 'reply_to_email', 'reply_all', 'forward_email',
  'pair_recipient', 'move_to_spam', 'move_to_spam_batch',
  'create_label', 'update_label', 'delete_label', 'get_or_create_label',
];

// What .mcp.json actually says since gmail.send was granted on 2026-09-01:
// pairing off (the permission prompt is the gate on recipients), send budgeted
// rather than clamped to a tripwire.
const GOOD_ENV = {
  GMAIL_MCP_RECIPIENT_PAIRING: 'false',
  GMAIL_MCP_RATE_LIMIT_modify: '60/day,900/month',
  GMAIL_MCP_RATE_LIMIT_send: '20/day,200/month',
};
const settingsWith = (deny, allow = []) => ({ permissions: { deny, allow } });
const fullDeny = MUST_DENY.map((n) => `mcp__gmail__${n}`);

console.log('A correct setup');
{
  const r = checkFences(REGISTERED, settingsWith(fullDeny), GOOD_ENV, []);
  check('passes with nothing to report', r.problems.length === 0, r.problems.join('; '));
  check('  ...and says the outward tools are fenced',
        r.passed.some((p) => p.includes('denied by name')), r.passed.join(' | '));
}

console.log('\nSending must not be pre-approved for jobs');
{
  // Not denied — Alex granted gmail.send. But never in the allow list either:
  // that list is what the unattended jobs may use without being asked.
  const r = checkFences(REGISTERED, settingsWith(fullDeny), GOOD_ENV, []);
  check('send tools neither allowed nor denied is the correct state',
        !r.problems.some((p) => p.includes('send')), r.problems.join('; '));
  check('  ...and it says they ask in chat and are refused in jobs',
        r.passed.some((p) => p.includes('ask Alex in chat')), r.passed.join(' | '));

  const withSend = checkFences(REGISTERED,
    settingsWith(fullDeny, ['mcp__gmail__send_email']), GOOD_ENV, []);
  check('putting send_email in the allow list is caught',
        withSend.problems.some((p) => p.includes('send_email')), withSend.problems.join('; '));
  check('  ...and says why it matters',
        withSend.problems.some((p) => p.includes('canUseTool')));
}

console.log('\nThe ways it goes wrong');
{
  // The exact regression this exists to catch: the deny list was written
  // against another project's naming and matched nothing real.
  const wrongNames = ['mcp__gmail__trash_message', 'mcp__gmail__delete_forever'];
  const r = checkFences(REGISTERED, settingsWith(wrongNames), GOOD_ENV, []);
  check('a deny list of names that do not exist is caught',
        r.problems.some((p) => p.includes('registered and not denied')),
        r.problems.join('; '));
  check('  ...and says which tools those are',
        r.problems.some((p) => p.includes('move_to_spam') && p.includes('pair_recipient')));
  check('  ...and notes the rules that match nothing',
        r.notes.some((n) => n.includes('does not register')), r.notes.join('; '));
}
{
  const partial = fullDeny.filter((n) => !n.endsWith('pair_recipient'));
  const r = checkFences(REGISTERED, settingsWith(partial), GOOD_ENV, []);
  check('one missing rule is caught',
        r.problems.some((p) => p.includes('pair_recipient')), r.problems.join('; '));
}
{
  // The trap the old fixture would have walked into. Pairing on, nothing
  // paired, pair_recipient denied: every send fails and nothing can make one
  // succeed. Read as a safety layer, it is really the granted capability
  // silently not working — found when Alex has already approved a send.
  const r = checkFences(REGISTERED, settingsWith(fullDeny),
                        { ...GOOD_ENV, GMAIL_MCP_RECIPIENT_PAIRING: 'true' }, []);
  check('pairing on with nothing paired and pair_recipient denied bricks sending',
        r.problems.some((p) => p.includes('every send will fail')), r.problems.join('; '));

  // Same config, but nothing that sends is registered — the pre-gmail.send
  // state. Then an empty pairing list really is free belt and braces.
  const readOnlyish = REGISTERED.filter((n) => !/^(send_|reply_)/.test(n));
  const r2 = checkFences(readOnlyish, settingsWith(fullDeny),
                         { ...GOOD_ENV, GMAIL_MCP_RECIPIENT_PAIRING: 'true' }, []);
  check('  ...but is fine when the server registers nothing that sends',
        !r2.problems.some((p) => p.includes('every send will fail')), r2.problems.join('; '));
}
{
  const r = checkFences(REGISTERED, settingsWith(fullDeny),
                        { ...GOOD_ENV, GMAIL_MCP_RECIPIENT_PAIRING: 'true' },
                        ['someone@example.com']);
  check('a paired address is a problem — it can be emailed without approval',
        r.problems.some((p) => p.includes('paired')), r.problems.join('; '));
}
{
  const r = checkFences(REGISTERED, settingsWith(fullDeny),
                        { ...GOOD_ENV, GMAIL_MCP_RATE_LIMIT_modify: '5000/day,50000/month' }, []);
  check('an unbounded modify limit is a problem',
        r.problems.some((p) => p.includes('modify rate limit')), r.problems.join('; '));
}
{
  const { GMAIL_MCP_RATE_LIMIT_modify, GMAIL_MCP_RATE_LIMIT_send, ...noLimits } = GOOD_ENV;
  const r = checkFences(REGISTERED, settingsWith(fullDeny), noLimits, []);
  check('no override at all falls back to the server default and is caught',
        r.problems.length === 2, r.problems.join('; '));
}

console.log('\nRead-only, for comparison');
{
  const readOnly = ['read_email', 'search_emails', 'get_thread', 'list_email_labels'];
  const r = checkFences(readOnly, settingsWith([]), GOOD_ENV, []);
  check('nothing dangerous is registered, so an empty deny list is fine',
        !r.problems.some((p) => p.includes('not denied')), r.problems.join('; '));
  check('  ...and it says so rather than claiming the deny list worked',
        r.passed.some((p) => p.includes('is even registered')), r.passed.join(' | '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
