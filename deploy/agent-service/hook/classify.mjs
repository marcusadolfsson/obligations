/**
 * Is this a login code, right now?
 *
 * A pure function over message headers. No I/O, no network, no model — this is
 * the thing that decides whether Alex's phone rings at 03:00, and it must be
 * something you can read in one sitting and test exhaustively.
 *
 * **The body is never an input.** Not an optimisation: an injection in a message
 * body has no reader anywhere in this path, because nothing here ever sees one.
 * Everything below comes from headers Gmail wrote or the sender declared.
 *
 * ## The order matters
 *
 * DMARC is checked first because it is the only condition that cannot be
 * satisfied by an attacker. Everything else — the sender domain, the subject —
 * is text anyone can put in a message. `dmarc=pass` is Gmail's own assertion,
 * written on receipt, that the mail really is from the domain it names. Without
 * it, listing `google.com` would mean anyone who can spoof a From line can wake
 * him.
 *
 * ## The sender list is a fast lane, not a gate
 *
 * By default anything matching a ratified subject pattern comes through, listed
 * sender or not. Alex's call, 2026-08-30: a missed code is the failure he
 * cares about, and he mutes SMS overnight.
 *
 * **Be clear-eyed about what that costs.** DMARC proves a mail is from the
 * domain it claims, not that the domain is trusted — an attacker sends from
 * their own domain with valid DMARC and a code-shaped subject. So under
 * `open` mode anyone who knows his address can make his phone buzz, up to the
 * rate caps. The blocklist is the first lever; `REALTIME_MODE=strict` restores
 * the sender table as a hard gate.
 *
 * Being listed still buys the domain-bound autofill line and a looser rate
 * limit, which is why ratifying is worth doing without being mandatory.
 *
 * ## Ambiguity is "no"
 *
 * There is no maybe. Anything not confidently a code returns `none` and is
 * handled by the 07:00 triage like any other mail. The cost of a miss is that he
 * goes and reads it; the cost of a false positive is a phone that rings for
 * things he did not approve, and that ends the channel.
 */

/** How fresh a code has to be. A code older than this is worthless anyway, and
 *  this is what makes a Pub/Sub retry after an outage harmless. */
export const FRESH_MS = 10 * 60 * 1000;

const lower = (v) => String(v ?? '').toLowerCase();

/** Case-insensitive header lookup — Gmail's casing is not guaranteed. */
export function header(headers, name) {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (k.toLowerCase() === want) return String(v ?? '');
  }
  return '';
}

/** The bare address out of `Name <addr>`, or the whole thing if it is bare. */
export function address(value) {
  const m = /<([^>]+)>/.exec(String(value ?? ''));
  return lower(m ? m[1] : value).trim();
}

export function senderDomain(from) {
  const at = address(from).lastIndexOf('@');
  return at < 0 ? '' : address(from).slice(at + 1);
}

/**
 * The registrable-ish parent, so `e.slack.com` matches a listed `slack.com`.
 *
 * Deliberately naive — no public-suffix list. It matches a domain against the
 * ratified list by walking up one label at a time, so a listed `slack.com`
 * covers `e.slack.com`, and a listed `co87dd.example` would cover far too much. That is
 * acceptable because the list is Alex's and short; it is not a general-purpose
 * domain matcher and should not be reused as one.
 */
export function matchSender(domain, senders) {
  const parts = String(domain ?? '').split('.').filter(Boolean);
  for (let i = 0; i < parts.length - 1; i++) {
    const candidate = parts.slice(i).join('.');
    if (!senders.has(candidate)) continue;
    // Takes a Map (the sender table) or a Set (the blocklist); a Set has no
    // get(), and a truthy return is all the blocklist check needs.
    const extra = typeof senders.get === 'function' ? senders.get(candidate) : null;
    return { domain: candidate, ...(extra && typeof extra === 'object' ? extra : {}) };
  }
  return null;
}

/** Levenshtein, bounded — only ever called on two short domain strings. */
function distance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let prev = [...Array(b.length + 1).keys()];
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1,
                        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

/**
 * A domain that is *almost* one he ratified, but is not it.
 *
 * `goog1e.com` against a listed `google.com`. This is the one place where the
 * open setting is unambiguously being exploited rather than merely used: a
 * legitimate service he has not listed looks nothing like one he has, while a
 * near-miss is a deliberate impersonation. Registering the domain and passing
 * DMARC on it is trivial, so DMARC cannot catch this.
 *
 * Refusing here costs a real code from a genuinely similar domain, which is a
 * price worth paying — he can list it, and then it matches exactly.
 */
export function nearMiss(domain, senders) {
  const parts = String(domain ?? '').split('.').filter(Boolean);
  if (parts.length < 2) return null;
  const registrable = parts.slice(-2).join('.');
  for (const listed of senders.keys()) {
    const target = listed.split('.').slice(-2).join('.');
    if (registrable === target) return null;          // exact, not a near-miss
    if (distance(registrable, target) <= 2) return listed;
  }
  return null;
}

/**
 * @param headers  the message's headers, as a flat object
 * @param opts.internalDate  epoch ms, from Gmail
 * @param opts.now           epoch ms
 * @param opts.policy        from hook/policy.mjs
 * @param opts.strict  treat the sender table as a gate rather than a fast lane
 * @returns {{tier: 'code'|'none', reason: string, ratified?: boolean,
 *            service?: string, loginDomain?: string|null}}
 */
export function classify(headers, { internalDate, now = Date.now(), policy,
                                    strict = false } = {}) {
  const no = (reason) => ({ tier: 'none', reason });

  if (!policy?.ok) return no('policy is not loaded');
  // Patterns are the gate; senders are not. With no patterns nothing can match,
  // which is the correct inert state.
  if (!policy.patterns.length) return no('no subject patterns ratified yet');

  // 1. DMARC. First, because it is the only check an attacker cannot satisfy.
  const auth = lower(header(headers, 'Authentication-Results'));
  if (!/\bdmarc=pass\b/.test(auth)) {
    return no(auth ? 'dmarc did not pass' : 'no Authentication-Results header');
  }

  // 2. The blocklist, which is absolute. Checked before anything else about the
  //    sender, because it is the lever for a sender that is abusing the open
  //    setting and it must not depend on the rest parsing.
  const from = header(headers, 'From');
  const dom = senderDomain(from);
  if (matchSender(dom, policy.blocked ?? new Set())) return no('sender is blocklisted');

  // 3. In strict mode the sender table is a gate. By default it is not — see
  //    the header. `hit` still decides the autofill line and the rate budget.
  const hit = matchSender(dom, policy.senders);
  if (strict && !hit) return no(`sender not ratified: ${dom || '(none)'}`);

  // A domain that is almost one he listed, but is not, is impersonation rather
  // than an unlisted service. Refused even in open mode.
  if (!hit) {
    const looksLike = nearMiss(dom, policy.senders);
    if (looksLike) return no(`${dom} is a near-miss of ratified ${looksLike}`);
  }

  // 4. Addressed to him, not to a list he happens to receive.
  if (policy.addresses.length) {
    const to = [header(headers, 'To'), header(headers, 'Delivered-To'),
                header(headers, 'Cc')].join(' ').toLowerCase();
    if (!policy.addresses.some((a) => to.includes(a))) {
      return no('not addressed to him');
    }
  }

  // 5. Vetoes before patterns: a mailing-list post can quote a code verbatim,
  //    and a "your weekly security digest" from a ratified sender will match a
  //    code pattern happily.
  if (header(headers, 'List-Id')) return no('a mailing list post, not a code');
  if (/auto-replied/i.test(header(headers, 'Auto-Submitted'))) return no('auto-reply');

  const subject = header(headers, 'Subject');
  if (policy.vetoSubject?.test(subject)) return no('subject matched a veto');

  // 6. The subject looks like a code.
  if (!policy.patterns.some((re) => re.test(subject))) {
    return no('subject matched no ratified pattern');
  }

  // 7. Fresh. Last, because it is the only condition that can change while the
  //    message sits in a retry queue, and the others are cheaper to evaluate.
  const age = now - Number(internalDate ?? 0);
  if (!Number.isFinite(age)) return no('no usable internalDate');
  if (age > FRESH_MS) return no(`stale by ${Math.round(age / 60000)} minutes`);
  // A timestamp in the future is a clock problem somewhere, not a fresh code.
  if (age < -60_000) return no('internalDate is in the future');

  return {
    tier: 'code',
    reason: hit
      ? 'ratified sender, ratified subject, dmarc pass, fresh'
      : 'unratified sender, ratified subject, dmarc pass, fresh',
    // Whether the sender is ratified, so the caller can pick the tighter rate
    // budget for one that is not.
    ratified: !!hit,
    service: hit ? (hit.what || hit.domain) : dom,
    // No mapping means the plain relay form: a domain-bound code naming the
    // wrong domain silently never offers, which is worse than not site-specific.
    loginDomain: hit?.login ?? null,
  };
}

/**
 * The text to relay. Both lines: the sentence so it is legible on a lock screen,
 * and Apple's domain-bound line so QuickType offers it on the right site.
 *
 * **The code is not extracted here and this never invents one.** It is passed
 * in by whatever read it, and if there is none the message says a code arrived
 * without pretending to carry it.
 */
export function relayText(code, loginDomain) {
  if (!code) return 'A verification code just arrived. It is in your mail.';
  const line = `Your verification code is ${code}`;
  return loginDomain ? `${line}\n\n@${loginDomain} #${code}` : line;
}
