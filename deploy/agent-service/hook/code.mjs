/**
 * Find the verification code.
 *
 * Most services put it in the body, not the subject — "Your verification code"
 * in the subject and the code underneath. An extractor that only read subjects
 * would relay "a code arrived, go and read your mail", which is most of what
 * Email 0 exists to abolish.
 *
 * ## Why reading a body is safe HERE and nowhere else
 *
 * The no-body rule elsewhere in this repo protects against prompt injection,
 * and prompt injection needs a model to read the text. Nothing on this path is
 * a model: `classify.mjs` is a pure function over headers, and this is a
 * regex. A body cannot talk either of them into anything.
 *
 * The property is preserved by keeping the blast radius at zero:
 *
 *   - classification happens on HEADERS ALONE, before a body is ever fetched.
 *     A message that is not already a fresh, DMARC-passing, pattern-matching
 *     code never has its body requested at all.
 *   - **nothing but the code leaves this module.** Not the body, not a snippet,
 *     not a "context" string for debugging. The return value is at most eight
 *     characters, every one of them `[A-Z0-9]`.
 *   - nothing here writes to disk or logs. The caller's spool line records that
 *     a code was relayed, never the code and never the text around it.
 *
 * If any of those three stops being true, the argument stops holding.
 *
 * ## Ambiguity returns null
 *
 * A body is full of numbers: years, order ids, phone numbers, footer addresses.
 * Guessing which one is the code is how a wrong code gets autofilled into
 * somebody's bank. Every rule below is anchored to something that makes it a
 * code — a label beside it, or a line with nothing else on it — and where two
 * candidates disagree the answer is null. The caller then relays "a code
 * arrived", which is a worse message and never a wrong one.
 */

/**
 * What a code looks like.
 *
 * Two shapes, because real ones come in both. Alex's ForeFlight code was
 * `A6BX6M` — an all-digit pattern would have found nothing in that mail and
 * relayed "a code arrived", which is the failure this module exists to fix.
 *
 *   digits   4-8 of them. Not 3, not 9+: those are years, prices and order ids.
 *   alnum    4-8 uppercase alphanumerics with at least one digit and one letter.
 *   letters  4-8 uppercase letters — but ONLY where position vouches for it.
 *
 * That last one is the awkward case. ForeFlight has issued Alex both `A6BX6M`
 * and `HEJKRR`, so letters-only cannot be rejected outright. But every
 * capitalised word is then a candidate, so it is accepted only beside a label
 * or alone on a line, never as a token floating loose in a body, and never if
 * it is in the short stop-list below.
 */
const DIGITS = '\\d{4,8}';
const ALNUM = '(?:[A-Z0-9]{4,8})';

/** Every code-shaped token. What counts as valid depends on where it was found. */
const CANDIDATE = `(?:${DIGITS}|${ALNUM})`;

const allDigits = (s) => /^\d{4,8}$/.test(s);
const mixed = (s) => /^[A-Z0-9]{4,8}$/.test(s) && /[A-Z]/.test(s) && /[0-9]/.test(s);
const allLetters = (s) => /^[A-Z]{4,8}$/.test(s);

/**
 * All-caps words that turn up in mail and are not codes.
 *
 * Needed because some services issue letters-only codes — ForeFlight's is
 * `HEJKRR` — so pure-letter tokens cannot simply be rejected. This is a short
 * stop-list rather than a dictionary on purpose: it only has to cover words
 * that appear *where a code appears*, which is beside a label or alone on a
 * line in an otherwise sparse template.
 */
const NOT_CODES = new Set([
  'TEAM', 'HELLO', 'THANKS', 'THANK', 'PLEASE', 'EMAIL', 'LOGIN', 'ENTER',
  'CLICK', 'HERE', 'YOUR', 'CODE', 'VERIFY', 'ACCOUNT', 'SECURITY', 'SUPPORT',
  'HELP', 'INFO', 'NOTE', 'FROM', 'SENT', 'DATE', 'TIME', 'NAME', 'USER',
  'HOME', 'NEWS', 'TERMS', 'LEGAL', 'ABOUT', 'PRIVACY', 'CONTACT', 'ADDRESS',
  'PHONE', 'MOBILE', 'ONLINE', 'WELCOME', 'MESSAGE', 'UPDATE', 'RENEW',
  'LATEST', 'PURCHASE', 'BUSINESS', 'SERVICE', 'COMPANY', 'CONFIRM', 'CANCEL',
  'EXPIRE', 'EXPIRES', 'MINUTES', 'HOURS', 'REPLY', 'SIGNIN', 'SIGNUP',
]);

/**
 * Valid where the surrounding text says "this is the code" — beside a label, or
 * alone on a line.
 *
 * Letters-only is allowed here, but it must still not look like a word. An
 * earlier version trusted position alone, which read `IOTA` alone on a line as
 * a code. Position plus gibberish is a much narrower claim and still catches
 * ForeFlight's `HEJKRR`, which is the case that made letters-only necessary at
 * all. Measured over 34 real code mails, nothing regressed.
 */
const isStrong = (s) =>
  allDigits(s) || mixed(s)
  || (allLetters(s) && !NOT_CODES.has(s) && !looksLikeWord(s));

/**
 * Does this text say, in so many words, that it contains a code?
 *
 * Stronger evidence than any shape rule: a mail that says "your verification
 * code" is a mail with a code in it. Used to unlock the looser token rule
 * below — Alex's suggestion, and the right one, because the risk of reading
 * a word as a code is only worth taking when the message has said outright
 * that a code is present.
 */
const CODE_PHRASE = new RegExp(
  '(?:verification|security|login|sign[- ]?in|one[- ]?time|access|confirmation)'
  + '[- ]?code|passcode|one[- ]?time[- ]?p(?:assword|in)'
  + '|verifieringskod|engångskod|inloggningskod|säkerhetskod', 'i');

export const saysCode = (text) => CODE_PHRASE.test(String(text ?? ''));

/**
 * Does this look like a word rather than a code?
 *
 * Cheap and deliberately crude — no dictionary, because the thing it has to
 * separate is not English from non-English but "plausible word" from "random
 * string". Two signals do most of the work:
 *
 *   - a run of four or more consonants (HEJKRR) is not a word
 *   - fewer than about a fifth vowels is not a word
 *
 * There is deliberately NO upper bound on vowels. An earlier version capped it
 * at two thirds, which made `IOTA` read as gibberish — and would have done the
 * same to `AREA` and `IDEA`, both three-quarters vowels and both plainly
 * words. Vowel-heavy strings are words far more often than they are codes, so
 * the ceiling was buying a false positive and nothing else.
 *
 * `HEJKRR` fails both tests and is a code. `SUPPORT`, `WELCOME` and `IOTA`
 * pass and stay refused wherever nothing positional vouches for them.
 */
export function looksLikeWord(s) {
  const t = String(s);
  if (!/^[A-Z]+$/.test(t)) return false;
  if (/[BCDFGHJKLMNPQRSTVWXZ]{4}/.test(t)) return false;
  return (t.match(/[AEIOUY]/g) ?? []).length / t.length >= 0.2;
}

/**
 * Valid as the ONLY code-shaped token in the whole message, with nothing
 * positional vouching for it.
 *
 * Digits and mixed alphanumerics always. Letters-only ONLY when the message
 * has explicitly said it contains a code AND the token does not look like a
 * word — which is what lets a future `HEJKRR` in an unfamiliar layout through
 * while `Please contact SUPPORT` still does not.
 */
const isCandidate = (s, { explicit = false } = {}) =>
  allDigits(s) || mixed(s)
  || (explicit && allLetters(s) && !NOT_CODES.has(s) && !looksLikeWord(s));

/**
 * Words that sit next to a code, in the languages Alex actually receives.
 * Swedish included for the same reason `rules/realtime-push.md` includes it in
 * the subject patterns: he is on `.se` services and a monolingual set misses.
 */
const LABEL = '(?:verification|security|login|sign[- ]?in|one[- ]?time|access|confirmation'
            + '|passcode|pass ?code|otp|pin|code'
            + '|verifieringskod|engångskod|inloggningskod|säkerhetskod|kod)';

/** Only ever look at the start of a body. A code is never on page nine. */
const MAX_CHARS = 4000;

/** How far past a label to look for its code. Wide enough for "is", narrow
 *  enough that a label cannot claim an unrelated number further along. */
const LABEL_WINDOW = 48;

/**
 * HTML to something a regex can read, **with its line structure intact**.
 *
 * Not a parser and not trying to be. Two jobs:
 *
 * 1. Script and style contents are dropped whole. They are full of digits and
 *    none of them are codes.
 * 2. Block-level tags become NEWLINES; everything else becomes a space.
 *
 * The second is the one that matters, and getting it wrong cost real misses.
 * Turning every tag into a space collapses an entire HTML mail onto one line,
 * which destroys the "alone on a line" rule — the strongest signal there is,
 * and the one that picks the code out of a signature block full of ZIPs and
 * street numbers. Measured against Alex's own mail: SimCo, RideCo,
 * ForeFlight and State Registered Agent were all missed for exactly this
 * reason, and all are found once the line breaks survive.
 *
 * Inline tags still become spaces, so `<b>12</b><b>3456</b>` cannot fuse into a
 * number that was never displayed.
 */
const BLOCK = 'br|p|div|tr|td|th|table|li|ul|ol|h[1-6]|section|article|header|footer|blockquote';

export function stripHtml(html) {
  return String(html ?? '')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(new RegExp(`</?(?:${BLOCK})\\b[^>]*>`, 'gi'), '\n')
    .replace(/<[^>]+>/g, ' ')
    // Invisible padding. Marketing templates pad the preheader with hundreds of
    // zero-width non-joiners so the preview text ends where they want it; left
    // in, they bury the actual content under a wall of `&zwnj;`.
    .replace(/&(?:zwnj|zwj|shy|#x200[BCD];|#820[34];|#173);/gi, '')
    .replace(/&nbsp;|&#(?:xA0|160);/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/[ \t ]+/g, ' ');
}

/**
 * The code in a piece of text, or null.
 *
 * Three rules, strongest first. Each returns only on an unambiguous answer.
 */
export function codeIn(text, { explicit } = {}) {
  const t = String(text ?? '').slice(0, MAX_CHARS);
  if (!t) return null;

  // The message can vouch for itself. When the caller has other evidence — a
  // code-shaped subject, say — it passes `explicit` in.
  const saidSo = explicit ?? saysCode(t);
  const loose = (x) => isCandidate(x, { explicit: saidSo });

  // Each rule returns only on ONE distinct answer. Two different candidates at
  // the same strength is the ambiguous case, and it must not guess.
  const only = (list, valid = isCandidate) => {
    const u = [...new Set(list.filter(valid))];
    return u.length === 1 ? u[0] : (u.length ? null : undefined);
  };

  // 1. Beside a label: "Your verification code is 284913", "code: A6BX6M".
  //
  //    Done as two passes rather than one regex, and the reason is a real bug
  //    this had: a case-insensitive pattern makes `[A-Z0-9]{4,8}` match
  //    lowercase words too, so a lazy quantifier grabs the nearest TOKEN —
  //    "code" in "verification code is 449827" — which then fails validation
  //    and loses the actual code. Alex's PayPal mail was missed exactly so.
  //
  //    Labels are matched case-insensitively; candidates are matched
  //    case-SENSITIVELY in the window after each one, and the first VALID
  //    candidate wins rather than the first token.
  const labelled = [];
  for (const m of t.matchAll(new RegExp(`${LABEL}\\b`, 'gi'))) {
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + LABEL_WINDOW);
    // Same line only: a label must not claim a number three lines further down.
    const line = after.split('\n')[0];
    for (const c of line.matchAll(new RegExp(`\\b(${CANDIDATE})\\b`, 'g'))) {
      if (isStrong(c[1])) { labelled.push(c[1]); break; }
    }
  }
  const byLabel = only(labelled, isStrong);
  if (byLabel !== undefined) return byLabel;

  // 2. Alone on a line. How almost every template presents it, and how
  //    ForeFlight does: "Enter your verification code." then A6BX6M by itself.
  //
  //    `[^\S\n]` is whitespace-except-newline, so a CRLF body still counts as
  //    "alone on a line" — `[ \t]` did not match the \r and missed every
  //    Windows-line-ending mail, which is most HTML mail.
  const alone = only([...t.matchAll(
    new RegExp(`(?:^|\\n)[^\\S\\n]*(${CANDIDATE})[^\\S\\n]*(?=$|\\n)`, 'g'))].map((m) => m[1]),
    isStrong);
  if (alone !== undefined) return alone;

  // 3. Exactly one code-shaped token in the whole text. Safe precisely because
  //    it is the only candidate; a second one makes this null.
  const any = only(t.match(new RegExp(`\\b${CANDIDATE}\\b`, 'g')) ?? [], loose);
  return any ?? null;
}

/**
 * The code for a message: subject first, then body.
 *
 * Subject first because it is a header Gmail parsed, it is already in hand, and
 * a code there needs no second network call. `fetchBody` is only invoked when
 * the subject has none — so a service that puts the code in the subject never
 * causes a body to be fetched at all.
 *
 * @param subject   the Subject header
 * @param fetchBody `() => Promise<{text?, html?}>`, called at most once
 */
export async function codeFor(subject, fetchBody) {
  const fromSubject = codeIn(subject);
  if (fromSubject) return { code: fromSubject, from: 'subject' };
  if (typeof fetchBody !== 'function') return { code: null, from: 'none' };

  let body;
  try {
    body = await fetchBody();
  } catch {
    // A body that cannot be fetched is not an error worth failing the push
    // over: the relay still says a code arrived, which is what it would have
    // said anyway a moment ago.
    return { code: null, from: 'body-unavailable' };
  }

  const text = body?.text || stripHtml(body?.html);
  // The SUBJECT counts as the message saying so. "Your ForeFlight Verification
  // Code" with a bare token in the body is exactly the shape this unlocks.
  const explicit = saysCode(subject) || saysCode(text);
  const found = codeIn(text, { explicit });
  return { code: found, from: found ? 'body' : 'none' };
}
