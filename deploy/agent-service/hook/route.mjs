/**
 * The Pub/Sub push endpoint: from "Gmail says something arrived" to "Alex's
 * phone buzzes", in one place.
 *
 * ## Ack first, work afterwards
 *
 * Pub/Sub retries anything it does not get a prompt 2xx for, so slow work
 * inside the response is how one code becomes four. The handler verifies,
 * answers, and queues. Everything after the ack is best-effort by design: the
 * cursor does not advance unless the work finished, so a crash costs a repeat
 * rather than a miss.
 *
 * ## It never touches `busy`
 *
 * `busy` is the agent's single-flight flag. This route neither checks nor sets
 * it, deliberately: a webhook must not be able to 409 Alex's chat, and a chat
 * turn in flight must not delay a login code by two minutes. They are unrelated
 * pieces of work that happen to live in one process. The queue below is this
 * path's own, so two pushes arriving together are still serialised.
 *
 * ## The code: subject first, then the body if it has to
 *
 * Most services put it in the body — ForeFlight, Zoom, PayPal and Intuit all
 * do — so a subject-only extractor would usually relay "a code arrived, go and
 * read your mail", which is the thing Email 0 exists to abolish.
 *
 * A body is fetched only for a message ALREADY classified as a code from its
 * headers, only by `code.mjs`, and nothing but the code comes back out. It is
 * never written to disk, logged, spooled, or read by a model. See `code.mjs`
 * for why that keeps the injection argument intact.
 *
 * ## The code is never written down
 *
 * It goes into one SMS and nowhere else. The spool line that becomes a
 * `messages/` file records that a code was relayed, from whom, and how it was
 * delivered — never the digits. `rules/realtime-push.md`: never quote a code.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { verifyPushToken } from './oidc.mjs';
import { loadPolicy } from './policy.mjs';
import { classify, relayText, senderDomain, header } from './classify.mjs';
import { codeFor } from './code.mjs';
import * as gmail from './gmail.mjs';
import * as rate from './rate.mjs';

const SPOOL = ['.log', 'email-pushes.jsonl'];

/** Decode the Pub/Sub envelope. Returns null when it is not one. */
export function decodeEnvelope(body) {
  try {
    const data = body?.message?.data;
    if (!data) return null;
    const inner = JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
    return {
      emailAddress: inner.emailAddress ?? null,
      historyId: inner.historyId ? String(inner.historyId) : null,
      pubsubMessageId: body.message.messageId ?? null,
    };
  } catch {
    return null;
  }
}

/** One at a time, so two pushes cannot interleave on the same cursor. */
let chain = Promise.resolve();
export function enqueue(work) {
  chain = chain.then(work).catch(() => {});
  return chain;
}

/**
 * Verify the request. Returns `{ ok }` or `{ status, error }`.
 *
 * The path secret is checked before the token: it is cheap, and it means a
 * scanner hitting the hostname never causes a JWKS fetch.
 */
export async function authorize(req, url, cfg, deps = {}) {
  const verify = deps.verifyPushToken ?? verifyPushToken;

  if (!cfg.secret) return { status: 503, error: 'push endpoint not configured' };
  const want = `/hooks/gmail/${cfg.secret}`;
  if (url.pathname !== want) return { status: 404, error: 'not found' };

  const auth = String(req.headers?.authorization ?? '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  try {
    await verify(token, { aud: cfg.audience, serviceAccount: cfg.serviceAccount });
  } catch (e) {
    return { status: 401, error: String(e.message) };
  }
  return { ok: true };
}

/**
 * Everything after the ack: what changed, is any of it a code, may it push.
 *
 * Returns a summary for the log. Never throws to the caller — this runs
 * detached from a request that has already been answered, and an unhandled
 * rejection here would take the service down for a message that does not
 * matter.
 */
export async function process(vault, { account = 'gmail', cfg = {}, deps = {} } = {}) {
  const g = deps.gmail ?? gmail;
  const notify = deps.notify;                    // required; injected for tests
  const now = deps.now ?? (() => Date.now());
  const out = { seen: 0, pushed: 0, refused: [], errors: [] };

  let changed;
  try {
    changed = await g.since(vault, { account });
  } catch (e) {
    out.errors.push(String(e.message));
    return out;
  }
  if (changed.unarmed) { out.errors.push('watch is not armed'); return out; }
  if (changed.stale) { out.errors.push('history cursor is older than Gmail retains'); return out; }

  const policy = await (deps.loadPolicy ?? loadPolicy)(vault);
  let state = rate.prune(await rate.load(vault), now());

  for (const id of changed.ids) {
    out.seen++;
    let meta;
    try {
      meta = await g.metadata(vault, id, { account });
    } catch (e) {
      out.errors.push(`${id}: ${e.message}`);
      continue;
    }

    const verdict = (deps.classify ?? classify)(meta.headers, {
      internalDate: meta.internalDate, now: now(), policy,
      strict: cfg.strict === true,
    });
    if (verdict.tier !== 'code') { out.refused.push(verdict.reason); continue; }

    const sender = senderDomain(header(meta.headers, 'From'));
    const decision = rate.decide(state,
      { messageId: id, sender, ratified: verdict.ratified }, now());

    if (!decision.allow) {
      out.refused.push(decision.reason);
      if (decision.announce) {
        state = rate.markSuppressed(state, now());
        await rate.save(vault, state);
        // The one message that says pushes are being dropped. Sent on the
        // notification channel, not the SMS one: it is not a code, and it must
        // not train him to expect codes from that number.
        await notify({
          title: 'Obligations',
          body: rate.suppressionMessage(decision.suppressed ?? 0),
          channel: 'ntfy', priority: 'high',
        });
        await spool(vault, { kind: 'suppressed', at: new Date().toISOString(),
                             count: decision.suppressed ?? 0 });
      }
      continue;
    }

    // Recorded BEFORE the send. An ambiguous send counts as sent; the
    // alternative once delivered the same code twice. See rate.mjs.
    state = rate.record(state, { messageId: id, sender, ratified: verdict.ratified }, now());
    await rate.save(vault, state);

    // Body fetched only now — after DMARC, the pattern, freshness and the caps
    // have all passed. A message that is not a code never has its body read.
    const { code, from } = await codeFor(
      header(meta.headers, 'Subject'),
      () => g.body(vault, id, { account }));
    const delivery = await notify({
      title: '',                                 // SMS has none, and a prefix can stop autofill
      body: relayText(code, verdict.loginDomain),
      channel: 'sms', priority: 'high',
    });

    out.pushed++;
    await spool(vault, {
      kind: 'code',
      at: new Date().toISOString(),
      // Deliberately not the code, and not the subject — a subject is where the
      // code usually is. Service and sender are enough to know what arrived.
      service: verdict.service ?? sender,
      sender,
      ratified: !!verdict.ratified,
      had_code: !!code,
      // Where it was found, never what it was. Useful for noticing that a
      // service moved its code into an attachment or an image.
      code_from: from,
      delivered: delivery?.channel ?? 'none',
      ok: !!delivery?.ok,
      detail: delivery?.ok ? null : String(delivery?.detail ?? '').slice(0, 200),
    });
  }

  // Only now. A crash above costs a repeat, which is survivable; advancing
  // first would cost a miss, which for a login code is the whole failure.
  if (changed.historyId) await g.advance(vault, account, changed.historyId);
  return out;
}

/**
 * Append one line for the dispatcher to turn into a `messages/` file.
 *
 * The service does not write the repo on this path. Push latency is seconds and
 * matters; record latency is a minute and does not. The dispatcher already
 * holds the locks that make a repo write safe.
 */
export async function spool(vault, entry) {
  const path = join(vault, ...SPOOL);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(entry) + '\n');
}
