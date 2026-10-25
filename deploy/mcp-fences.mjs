/**
 * The rules that fence in Gmail write access, as a pure function.
 *
 * Separated from `mcp-check.mjs` so they can be tested without a live mailbox.
 * Under `gmail.modify` the deny list is what stands between a prompt injection
 * in an email body and a mail going out as Alex, and a deny list that has
 * quietly stopped matching the tool names looks exactly like one that works.
 */

// Destroys mail, widens the agent's own reach, or stands up a rule that keeps
// acting after the session ends. Every one must be denied by name.
export const MUST_DENY = [
  'pair_recipient', 'delete_email', 'batch_delete_emails',
  'move_to_spam', 'move_to_spam_batch',
  'create_filter', 'create_filter_from_template', 'delete_filter',
];

/**
 * Sending. Alex granted `gmail.send` on 2026-09-01, so these are no longer
 * denied — but they must never be **allowed** either.
 *
 * The allow list is what the *scheduled jobs* may use: a job's `canUseTool` is a
 * blanket deny, so anything not pre-approved there never runs unattended. A tool
 * in neither list falls through to `canUseTool`, which asks Alex in chat and
 * refuses in a job. That is exactly the shape sending should have.
 *
 * Putting one of these in `allow` would hand the unattended jobs — the ones that
 * read attacker-controlled email with nobody watching — a send button.
 */
export const MUST_NOT_BE_ALLOWED = [
  'send_email', 'send_draft', 'reply_to_email', 'reply_all', 'forward_email',
];

// A busy day of triage, and nowhere near a mailbox. The failure mode of a
// confused run is not one wrong archive.
/** A normal day of replies is single digits; this is the loop backstop. */
export const MAX_SEND_PER_DAY = 50;

const MAX_MODIFY_PER_DAY = 200;

const dailyFrom = (v) => {
  const m = /^(\d+)\s*\/\s*day/.exec(String(v ?? ''));
  return m ? Number(m[1]) : Infinity;      // no override means the server default
};

/**
 * @param names     tool names the server actually registered
 * @param settings  parsed .claude/settings.json
 * @param env       the gmail server's env block from .mcp.json
 * @param paired    addresses in the pairing allowlist
 * @param server    the .mcp.json key, which is the tool-name prefix. A second
 *                  mailbox is a second server with its own prefix, and its own
 *                  deny rules — this server has no multi-account support.
 * @returns {{problems: string[], notes: string[], passed: string[]}}
 */
export function checkFences(names, settings, env = {}, paired = [], server = 'gmail') {
  const problems = [];
  const notes = [];
  const passed = [];

  const denied = new Set(settings?.permissions?.deny ?? []);
  const registered = new Set(names);

  const loose = MUST_DENY.filter((n) => registered.has(n) && !denied.has(`mcp__${server}__${n}`));
  if (loose.length) {
    problems.push(`registered and not denied: ${loose.join(', ')}`);
  } else {
    const guarded = MUST_DENY.filter((n) => registered.has(n));
    passed.push(guarded.length
      ? `all ${guarded.length} destructive tools are denied by name`
      : 'no destructive tool is even registered');
  }

  // Sending must reach canUseTool, which asks in chat and refuses in a job.
  const allowed = new Set(settings?.permissions?.allow ?? []);
  const preapproved = MUST_NOT_BE_ALLOWED
    .filter((n) => allowed.has(`mcp__${server}__${n}`));
  if (preapproved.length) {
    problems.push(`pre-approved for unattended jobs: ${preapproved.join(', ')} ` +
                  '— these must fall through to canUseTool, not sit in the allow list');
  } else {
    const sendable = MUST_NOT_BE_ALLOWED.filter((n) => registered.has(n));
    passed.push(sendable.length
      ? `${sendable.length} send tools ask Alex in chat and are refused in jobs`
      : 'nothing that sends is registered');
  }

  // Not a failure — a deny rule for an absent tool is harmless — but a list
  // full of names that never existed is how one stops being read.
  const prefix = `mcp__${server}__`;
  const stale = [...denied]
    .filter((d) => d.startsWith(prefix))
    .map((d) => d.slice(prefix.length))
    .filter((n) => !registered.has(n));
  if (stale.length && names.length) {
    notes.push(`${stale.length} deny rule(s) name tools this server does not register: ${stale.join(', ')}`);
  }

  // Recipient pairing: a server-side allowlist of addresses that may be emailed.
  //
  // It was ON with an empty list while sending was denied outright — free belt
  // and braces on a capability that did not exist. With gmail.send granted it
  // stops being free, because an empty list plus a denied `pair_recipient` means
  // **every send fails and there is no way to make one succeed**. That is not a
  // safety layer, it is the granted capability quietly not working, discovered
  // at the moment Alex has already approved a send.
  //
  // So OFF is the correct setting, and the gate is the permission prompt, which
  // shows him the recipient and waits. What is checked here is coherence: if
  // pairing is on, sending must still be *possible*, or say so plainly.
  const pairingOn = env.GMAIL_MCP_RECIPIENT_PAIRING === 'true';
  const canSend = registered.has('send_email') || registered.has('reply_to_email');
  if (!pairingOn) {
    passed.push('recipient pairing off; the permission prompt is the gate on recipients');
  } else if (paired.length) {
    problems.push(`${paired.length} address(es) are paired and could be emailed without approval`);
  } else if (canSend && denied.has(`${prefix}pair_recipient`)) {
    problems.push('pairing is on, nothing is paired, and pair_recipient is denied — ' +
                  'every send will fail with no way to fix it. Turn pairing off.');
  } else {
    passed.push('recipient pairing is on with an empty allowlist — a send has nowhere to go');
  }

  const modify = env.GMAIL_MCP_RATE_LIMIT_modify;
  if (dailyFrom(modify) > MAX_MODIFY_PER_DAY) {
    problems.push(`the modify rate limit is ${modify ?? '(server default)'}; ` +
                  `cap it at ${MAX_MODIFY_PER_DAY}/day or less`);
  } else {
    passed.push(`modify is capped at ${modify}`);
  }

  // Sending is real now, so the limit is a budget rather than a tripwire. It is
  // the backstop for the case the prompt cannot catch: not one wrong send, but
  // a loop. A normal day of replies is single digits.
  const send = env.GMAIL_MCP_RATE_LIMIT_send;
  if (dailyFrom(send) > MAX_SEND_PER_DAY) {
    problems.push(`the send rate limit is ${send ?? '(server default)'}; ` +
                  `cap it at ${MAX_SEND_PER_DAY}/day or less — it is the backstop ` +
                  'against a loop, not against one bad send');
  } else {
    passed.push(`send is capped at ${send}`);
  }

  return { problems, notes, passed };
}
