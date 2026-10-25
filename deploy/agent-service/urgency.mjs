/**
 * The second lane: does this need him now?
 *
 * Alex, 2026-09-20: "could we make it more realtime?" The first lane —
 * `hook/classify.mjs` — is deterministic and only for login codes. Everything
 * else waited for a triage gate built around cost: a Sonnet run has a floor,
 * so the mail job batches and the message job waits twenty minutes even for
 * someone he knows. This is the cheap tier in front of that: one small model
 * call over the new threads from PEOPLE HE KNOWS, asking one question —
 * *does he need to see this within the hour?* — and, on yes, the full triage
 * runs at once and its verdict is pushed to his phone.
 *
 * What holds it:
 *
 *   - **Known people only.** A text from a resolved contact, one-to-one; a
 *     mail whose sender the address book can name, not a list, not
 *     auto-submitted, not failing DMARC. A stranger cannot reach this lane, so
 *     a stranger cannot make his phone buzz through it — rules/realtime-push.md.
 *   - **The classifier decides *now or later*, nothing else.** It never sees a
 *     tool, never writes a file, never decides what the message means. The
 *     triage still does that, with the same skill it always has; this only
 *     moves it up.
 *   - **The push carries the triage's verdict, not the classifier's.** Only an
 *     OPEN, ACTION conclusion — the triage said the next move is his — is
 *     pushed. A "now" that the triage judged awareness or digest is silent.
 *   - **Quiet hours and a daily cap.** Nothing pushes 21:00–07:00 (the morning
 *     brief carries it); at most PER_DAY pushes a day. `.log/urgency.json`.
 *   - **Every thread is asked about once** per watermark. The ledger is what
 *     keeps a minute tick from asking the same question sixty times.
 *
 * Pure where it can be: `candidates`, `promptFor`, `parseVerdicts`,
 * `inQuietHours` take data and return data. `classifyUrgency` and
 * `pushAfterTriage` read the repo; the model call and the notifier are
 * injected so the tests hand in stubs.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { localStamp } from './time.mjs';
import { topicOf } from '../drafts.mjs';
import { loadContacts, resolveHandle } from './contacts.mjs';

export const URGENCY = {
  MODEL: process.env.OBLIGATIONS_URGENCY_MODEL || 'claude-haiku-4-5-20251001',
  PER_DAY: 8,            // pushes a day, this lane only
  QUIET_FROM: 21,        // no push from 21:00…
  QUIET_TO: 7,           // …until 07:00
  MAX_BATCH: 10,         // threads per model call; the rest wait a minute
  MAX_CHARS: 240,        // of each text message the classifier sees
};
const LEDGER = ['.log', 'urgency.json'];
/** Work-list reasons that mean "something new arrived" — never stale, aged-out or escaped. */
const NEW_REASONS = /^(not seen before|new messages)/;

export const keyOf = (e) => (e.thread_id ? `mail:${e.account ?? 'gmail'}:${e.thread_id}` : `im:${e.chat_id}`);

async function readJson(vault, rel, fallback) {
  try { return JSON.parse(await readFile(join(vault, rel), 'utf8')); } catch { return fallback; }
}
export async function readLedger(vault) {
  const d = await readJson(vault, join(...LEDGER), {});
  return { seen: d.seen ?? {}, pushed: d.pushed ?? {} };
}
async function writeLedger(vault, d) {
  await mkdir(join(vault, '.log'), { recursive: true });
  await writeFile(join(vault, ...LEDGER), JSON.stringify(d, null, 1) + '\n');
}

/* Cut at a word, and at a sentence where one is near. Alex, 2026-09-22, of
   a pushed note ending "He archived th…": a summary that stops mid-word reads
   as something broken rather than something shortened. */
const clip = (s, n = URGENCY.MAX_CHARS) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n - 1);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (stop > n * 0.6) return cut.slice(0, stop + 1);
  const space = cut.lastIndexOf(' ');
  return (space > 0 ? cut.slice(0, space) : cut).replace(/[,;:—-]$/, '') + '…';
};

/**
 * Which new threads are from people he knows, with what the classifier may
 * see of each. Pure over the two work lists, the two extracts, the address
 * book and the ledger.
 */
export function candidates({ mail = null, texts = null, mailExtract = null, textExtract = null, contacts = null, ledger = { seen: {} } } = {}) {
  const out = [];
  const seen = ledger?.seen ?? {};
  const textThreads = new Map((textExtract?.threads ?? []).map((t) => [t.chat_id, t]));
  for (const e of texts?.needs_judgement ?? []) {
    if (!NEW_REASONS.test(String(e.reason ?? ''))) continue;
    const t = textThreads.get(e.chat_id);
    if (!t || t.is_group) continue;
    const named = (e.participants ?? []).find((p) => p?.name);
    if (!named) continue;
    const key = keyOf(e);
    const watermark = (t.messages ?? []).map((m) => m.at).sort().pop() ?? '';
    if (seen[key]?.watermark === watermark) continue;
    const last = (t.messages ?? []).slice(-3);
    if (!last.length || last[last.length - 1].from_me) continue;      // his own last word is not a question to him
    out.push({
      key, channel: 'text', who: named.name, relation: named.relation ?? null, watermark, chat_id: e.chat_id,
      brief: last.map((m) => `${m.from_me ? 'Alex' : named.name}: ${clip(m.text)}`).join(' / '),
    });
  }
  const mailThreads = new Map((mailExtract?.threads ?? []).map((t) => [`${t.account}:${t.thread_id}`, t]));
  for (const e of mail?.needs_judgement ?? []) {
    if (!NEW_REASONS.test(String(e.reason ?? ''))) continue;
    const t = mailThreads.get(`${e.account}:${e.thread_id}`);
    if (!t || t.is_list || t.last_from_me) continue;
    const last = (t.messages ?? []).slice(-1)[0];
    if (!last || last.from_me || last.auto || last.list_id || last.dmarc_pass === false) continue;
    const who = resolveHandle(contacts ?? { index: {} }, last.from ?? e.sender);
    if (!who) continue;
    const key = keyOf(e);
    const watermark = t.watermark ?? e.watermark ?? '';
    if (seen[key]?.watermark === watermark) continue;
    out.push({
      key, channel: 'mail', who, relation: null, watermark, thread_id: e.thread_id, account: e.account,
      // Gmail's own opening line, where the extract has one — and what
      // addBodies() tests to decide whether the words are worth fetching.
      snippet: last.snippet ?? null,
      /* WHAT THEY SAID, where the extract has it. A mail candidate used to
         carry the subject and a message count, so the classifier answered
         from the topic — "technical integration topic, 3 messages suggests
         action" — for a mail that said "I emailed our account rep and will
         keep you posted". Texts have always carried their words; mail now
         carries Gmail's own snippet (metadata-format, redacted at the
         extractor). Older extracts have none, and then this reads as it did. */
      brief: `subject "${clip(t.subject ?? e.subject, 120)}"${t.never_replied ? ' — first mail from them on this' : ` — ${(t.messages ?? []).length} messages so far`}`
        + `${t.has_attachment ? ', with an attachment' : ''}`
        + `${last.snippet ? `. They wrote: "${clip(last.snippet, 200)}"` : ''}`,
    });
  }
  return out;
}

/** What the classifier is asked. Data after the instructions, one line per thread. */
export function promptFor(cands, now = new Date()) {
  const lines = cands.map((c, i) => `${i + 1}. [${c.channel}] from ${c.who}${c.relation ? ` (${c.relation})` : ''}: ${c.brief}`);
  return `It is ${localStamp(now)}. Each line below is a new message to Alex from someone he knows. `
    + `Answer one question per line: does he need to see it WITHIN THE HOUR? `
    + `Yes when a person is asking him something, proposing or confirming a time, reporting a problem with a property, aircraft or account, or when money is moving. `
    + `No for chatter, thanks, photos, newsletters, updates that can wait for the evening, and anything he already answered. `
    + `Reply with JSON only: an array of {"n": <line number>, "now": true|false, "why": "<ten words>"}. Nothing else.\n\n`
    + lines.join('\n');
}

/** The model's answer, robustly: anything unparseable is "later". */
export function parseVerdicts(text, cands) {
  const out = new Map(cands.map((c) => [c.key, { now: false, why: 'no verdict' }]));
  const m = String(text ?? '').match(/\[[\s\S]*\]/);
  if (!m) return out;
  let arr; try { arr = JSON.parse(m[0]); } catch { return out; }
  if (!Array.isArray(arr)) return out;
  for (const v of arr) {
    const c = cands[Number(v?.n) - 1];
    if (c) out.set(c.key, { now: v.now === true, why: clip(v.why, 80) || (v.now ? 'needs him' : 'can wait') });
  }
  return out;
}

export function inQuietHours(now = new Date()) {
  const h = now.getHours();
  return h >= URGENCY.QUIET_FROM || h < URGENCY.QUIET_TO;
}

/**
 * One pass: gather, ask once, remember. `ask(prompt) -> { text, costUSD, model }`.
 * Returns what is urgent (for the tick to run the triage on) and the numbers.
 */
/** How short a snippet has to be before it is worth fetching the body. */
export const THIN_SNIPPET = 80;

/** The new part of a reply: everything above the quoted thread and the signature. */
export function firstWords(text, max = 1200) {
  const lines = String(text ?? '').split('\n');
  const out = [];
  for (const l of lines) {
    if (/^\s*(?:On\b.*\bwrote:|From:\s|-{2,}\s*Original Message|_{5,}|Sent from my\b|Get Outlook for\b)/i.test(l)) break;
    if (/^\s*>/.test(l)) break;
    out.push(l);
    if (out.join(' ').length > max) break;
  }
  return out.join(' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * The words of a mail, where its snippet is too thin to judge by.
 *
 * Alex, 2026-09-22: "why can't we send the body to the classifier?" Nothing
 * forbids it — the rule that a body is never read belongs to the login-code
 * lane, which is deterministic and fires from headers alone. The obstacle was
 * only that nothing HAS the body here: the extract is metadata, and the body
 * cache holds threads that already have a conclusion, which a brand-new thread
 * does not. So this fetches one, read-only, and never writes it down.
 *
 * A fallback rather than the default: Gmail's snippet is the opening ~200
 * characters and is usually the whole answer ("I emailed our account rep at
 * TKE and will keep you posted"). This is for the mail whose snippet is a
 * greeting, or an HTML-only mail that has none.
 *
 * What comes back is a stranger's words, so it is treated as the triage treats
 * them: redacted for anything code-shaped, cut above the quoted reply, capped,
 * and handed to a classifier whose only answer is yes or no.
 */
export async function addBodies(vault, cands, { fetchThread, redact, limit = 3 } = {}) {
  const want = cands.filter((c) => c.channel === 'mail' && c.account && c.thread_id
    && String(c.snippet ?? '').length < THIN_SNIPPET).slice(0, limit);
  let fetched = 0, failed = 0;
  for (const c of want) {
    try {
      const { shape } = await import('../integrations/mail-cache.mjs');
      const full = await fetchThread(c.account, c.thread_id);
      const last = (shape(full, { account: c.account }).messages ?? []).slice(-1)[0];
      const words = firstWords(redact(last?.text ?? ''));
      if (!words) continue;
      c.body = words;
      c.brief += `. They wrote: "${clip(words, 600)}"`;
      fetched++;
    } catch { failed++; }                 // a fetch that fails leaves the snippet
  }
  return { fetched, failed, thin: want.length };
}

export async function classifyUrgency(vault, { ask, now = new Date() } = {}) {
  const [mail, texts, mailExtract, textExtract, contacts, ledger] = await Promise.all([
    readJson(vault, 'integrations/gmail-changed.json', null),
    readJson(vault, 'integrations/imessage-changed.json', null),
    readJson(vault, 'integrations/gmail.json', null),
    readJson(vault, 'integrations/imessage.json', null),
    loadContacts(vault).catch(() => null),
    readLedger(vault),
  ]);
  const all = candidates({ mail, texts, mailExtract, textExtract, contacts, ledger });
  const cands = all.slice(0, URGENCY.MAX_BATCH);
  if (!cands.length) return { asked: 0, now: [], batch: [], waiting: all.length, cost: null };
  /* The words, where the snippet is too thin to judge by. Counted either way,
     so "the snippet was enough" and "the fetch failed" are different facts. */
  let bodies = { fetched: 0, failed: 0, thin: 0 };
  try {
    const [{ fetchThread }, { redact }] = await Promise.all([
      import('../integrations/mail-cache.mjs'), import('../integrations/gmail-extract.mjs')]);
    bodies = await addBodies(vault, cands, { fetchThread, redact });
  } catch { /* no token, no network: the snippets stand */ }
  let verdicts, cost = null, model = null;
  try {
    const r = await ask(promptFor(cands, now));
    verdicts = parseVerdicts(r?.text, cands); cost = r?.costUSD ?? null; model = r?.model ?? null;
  } catch (err) {
    // A classifier that fails is a classifier that says "later": the gates
    // still run the triage on their own cadence. Remembered, so a broken
    // model does not re-ask every minute.
    verdicts = new Map(cands.map((c) => [c.key, { now: false, why: `classifier failed: ${String(err?.message ?? err).slice(0, 60)}` }]));
  }
  const at = localStamp(now);
  for (const c of cands) ledger.seen[c.key] = { watermark: c.watermark, at, ...verdicts.get(c.key) };
  // Keep the ledger to what can still matter: a week of seen, the pushes of the day.
  const cutoff = localStamp(new Date(now.getTime() - 7 * 86400e3));
  for (const [k, v] of Object.entries(ledger.seen)) if (String(v.at ?? '') < cutoff) delete ledger.seen[k];
  const today = at.slice(0, 10);
  for (const [k, v] of Object.entries(ledger.pushed)) if (String(v ?? '').slice(0, 10) !== today) delete ledger.pushed[k];
  await writeLedger(vault, ledger);
  const decided = cands.map((c) => ({ ...c, ...verdicts.get(c.key) }));
  return { asked: cands.length, now: decided.filter((c) => c.now), batch: decided.filter((c) => !c.now), waiting: all.length - cands.length, cost, model, bodies };
}

const headline = (what) => String(what ?? '').split(/\s+UPDATE\s+\d{4}-\d{2}-\d{2}/)[0].trim();

/**
 * What they actually said — the part a push is FOR.
 *
 * Alex, 2026-09-21, on the first live one: "why didn't it also include the
 * message, that would be helpful." It carried the conclusion's headline
 * instead, and a headline is written once and read for weeks: Leo had just
 * written "Let me check! Give me like 1 hr plz" and the note said "GateLink
 * vendor contact continuing the integration walkthrough", which was true three
 * days earlier and told him nothing about why his phone had buzzed.
 *
 * Everything they have said since his own last word, so a burst of three
 * arrives as three. Their words are DATA — never instructions — and they are
 * quoted, not summarised, because summarising is the judgement the triage has
 * already made and this is the evidence for it.
 */
export function saidSince(thread) {
  const msgs = thread?.messages ?? [];
  let lastMine = -1;
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]?.from_me) { lastMine = i; break; }
  return msgs.slice(lastMine + 1)
    .filter((m) => !m?.from_me && String(m?.text ?? '').trim())
    .slice(-3)
    .map((m) => ({ at: m.at, text: String(m.text).replace(/\s+/g, ' ').trim() }));
}

/**
 * After the triage has run on urgent threads: push the ones it made his.
 * `notify({title, body, priority}) -> { channel, ok }`. Writes a `note` for
 * each push so /briefs shows where it landed and `delivered:` says how.
 */
export async function pushAfterTriage(vault, { keys = [], notify, now = new Date(), log = async () => {} } = {}) {
  if (!keys.length) return { pushed: [], held: [] };
  const [es, is, textExtract, mailExtract, ledger] = await Promise.all([
    readJson(vault, 'integrations/email-state.json', { threads: [] }),
    readJson(vault, 'integrations/imessage-state.json', { threads: [] }),
    readJson(vault, 'integrations/imessage.json', { threads: [] }),
    readJson(vault, 'integrations/gmail.json', { threads: [] }),
    readLedger(vault),
  ]);
  const pushed = [], held = [];
  const today = localStamp(now).slice(0, 10);
  let count = Object.values(ledger.pushed).filter((v) => String(v).startsWith(today)).length;
  for (const key of keys) {
    let c = null, who = null, said = [], subject = null, lastFromMe = false, judgedTo = null, mineAfter = [];
    if (key.startsWith('mail:')) {
      const [, account, tid] = key.split(':');
      const t = (es.threads ?? []).find((x) => x.thread_id === tid && (x.account ?? 'gmail') === account);
      c = t?.conclusion ?? null; who = c?.who ?? null; judgedTo = t?.watermark ?? null;
      // A mail's words are in the body, which this never fetches — an
      // injection in a body has no reader on this path, and that is the
      // point. The subject is what the sender chose to put on the outside.
      const mt = (mailExtract.threads ?? []).find((x) => x.thread_id === tid);
      subject = c?.subject ?? mt?.subject ?? null;
      lastFromMe = !!mt?.last_from_me;
      mineAfter = (mt?.messages ?? []).filter((m) => m.from_me && !m.draft && judgedTo && String(m.at ?? '') > String(judgedTo));
    } else {
      const t = (is.threads ?? []).find((x) => `im:${x.chat_id}` === key);
      c = t?.conclusion ?? null; who = c?.who ?? null; judgedTo = t?.watermark ?? null;
      const tx = (textExtract.threads ?? []).find((x) => `im:${x.chat_id}` === key);
      said = saidSince(tx);
      mineAfter = (tx?.messages ?? []).filter((m) => m.from_me && judgedTo && String(m.at ?? '') > String(judgedTo));
    }
    if (!c) { held.push({ key, why: 'the triage wrote no conclusion' }); continue; }
    /* HE MAY HAVE ANSWERED WHILE THE TRIAGE RAN. Alex, 2026-09-21: "before
       pushing, let's verify there isn't new messages in the thread. On the
       last one I already answered in iMessage before the push came."
    
       The triage takes one to three minutes, and the Mac now pushes its
       extract on change, so a reply he typed in that window is already on
       disk by the time this runs. `saidSince` is read fresh here for exactly
       that reason: if nothing of theirs stands after his own last word, he
       has dealt with it, and a buzz would be telling him about his own
       reply. The same fact that supplies the quote proves the push is still
       warranted — and when it is empty, there is nothing to quote either. */
    /* HE ANSWERED AFTER THE LAST THING THE TRIAGE READ. Alex, 2026-09-25,
       of "Needs you now — Tell Leo yes to the call or push to tomorrow":
       "This alert doesn't make any sense." Leo asked at 17:31 for a call
       now or tomorrow; Alex wrote "Will call you in 5 min" at 17:33; Leo
       said "Ok" at 17:34. The triage judged an extract that ended at 17:31,
       so its verdict was right about the thread it saw. By the push at 17:35
       the fresh extract carried the whole exchange — and the check below
       passed, because "Ok" is theirs and stands after his reply. The push
       quoted it.

       The question is not whether they spoke last but whether the verdict is
       older than his answer. Anything he wrote after the triage's watermark
       means it judged a conversation he has since moved on; the next triage
       sees his reply, and if it still needs him the ordinary path says so. */
    if (mineAfter.length) {
      const last = mineAfter[mineAfter.length - 1];
      held.push({ key, why: `you wrote on the thread at ${String(last.at).slice(11, 16)}, after the last message the triage read (${String(judgedTo).slice(11, 16)}) — its verdict is older than your reply` });
      continue;
    }
    if (!key.startsWith('mail:') && !said.length) {
      held.push({ key, why: 'you answered on the thread while the triage was running' });
      continue;
    }
    if (key.startsWith('mail:') && lastFromMe) {
      held.push({ key, why: 'you replied on the thread while the triage was running' });
      continue;
    }
    const tier = c.tier ?? 'action';
    if (!(c.open && tier === 'action')) { held.push({ key, why: `the triage judged it ${tier}${c.open ? '' : ', nothing owed'}` }); continue; }
    /* SOMETHING THEY OWE CANNOT NEED HIM NOW. Alex, 2026-09-22, of a push
       about Lena's "I emailed our account rep at TKE and will keep you
       posted. Great idea!": "there was nothing in Lenas message that needed
       me now." There was not. The obligation is owed BY THEM — he is waiting
       on TKE's price — so their update on it is news, and news waits for the
       brief. The lane exists for the hour in which HE has to do something; if
       the triage has just read the thread and still says the ball is theirs,
       that is the answer, and it is arithmetic rather than a second guess. */
    if ((c.owed_by ?? 'me') === 'them') {
      held.push({ key, why: 'they owe this, not him — an update on it is not something he must act on within the hour' });
      continue;
    }
    if (ledger.pushed[key]) { held.push({ key, why: 'already pushed today' }); continue; }
    if (inQuietHours(now)) { held.push({ key, why: 'quiet hours — the morning brief carries it' }); continue; }
    if (count >= URGENCY.PER_DAY) { held.push({ key, why: `${URGENCY.PER_DAY} pushes today already` }); continue; }
    /* WHO WROTE, AND ABOUT WHAT. Alex, 2026-09-22, of a push headed "Needs
       you now — Chase Lena and Kyle on the TKE robot elevator quote", sent
       because Lena had just written to HIM: "why did that chase go out …?"
       Nothing went out — but the title was the task's, and a task title is an
       imperative from his side, so a push about their message read as a chase
       the assistant had sent. It names the person and what they wrote about now:
       the topic lifted out of the task title, else the subject they used. */
    const task = c.title || headline(c.what).slice(0, 80) || 'Something needs you';
    const about = topicOf(task) || subject || null;
    // Only where there is a real topic to name. Without one the task's own
    // title is the clearest thing there is — "Dana on Call the electrician
    // about the dock light" is worse than the title alone.
    const title = who && about ? `${who} on ${clip(about, 70)}` : clip(task, 80);
    /* THE PUSH SAYS WHAT THEY SAID. A buzz has one line to justify itself, and
       "he wrote this" justifies it; the conclusion's headline does not. */
    const quote = said.length ? said.map((m) => m.text).join(' / ') : subject;
    const push = `${who ? who + ': ' : ''}${clip(quote || headline(c.what), 200)}`;
    /* The note keeps the words as a quote, the triage's reading under them,
       and a link that reads as somewhere to go — CLAUDE.md: "A deep link is
       good; a bare path is not." It was rendering as percent-encoded noise. */
    const link = `/todo#pane=${encodeURIComponent(key)}`;
    const body = [
      said.length
        ? `**${who ?? 'They'}** said${said[0].at ? ` at ${String(said[0].at).slice(11, 16)}` : ''}:\n\n`
          + said.map((m) => `> ${m.text}`).join('\n>\n')
        : subject ? `**${who ?? 'They'}** wrote — *${subject}*` : null,
      clip(headline(c.what), 300),
      `[Open the task](${link})`,
    ].filter(Boolean).join('\n\n');
    const r = await notify({ title, body: push, priority: 'high' });
    const at = localStamp(now);
    ledger.pushed[key] = at; count++;
    pushed.push({ key, title, channel: r?.channel ?? 'none', ok: !!r?.ok });
    try {
      await mkdir(join(vault, 'messages'), { recursive: true });
      const stem = `${at.slice(0, 10)}-${at.slice(11, 13)}${at.slice(14, 16)}-now`;
      for (const name of [`${stem}.md`, `${stem}-2.md`, `${stem}-3.md`]) {
        try {
          await writeFile(join(vault, 'messages', name),
            /* Its own kind, not `note`. Alex, 2026-09-21: "tag the 'Needs
               you now' different than note on the brief tab." A note is
               something the assistant did on his behalf and is telling him about;
               this is the one thing that made his phone buzz, and the briefs
               list gets a chip per kind, so a kind of its own is the whole
               fix. The dispatcher's PUSHABLE set does not contain it — this
               path has already pushed, and a second one would double-buzz. */
            `---\ntype: message\nkind: urgent\nat: ${at}\ntitle: Needs you now — ${title.replace(/\n/g, ' ')}\nread: false\ndelivered: ${r?.ok ? (r.channel ?? 'none') : 'none'}\n---\n\n${body}\n`, { flag: 'wx' });
          break;
        } catch (err) { if (err.code !== 'EEXIST') throw err; }
      }
    } catch (err) { await log('urgency_note_failed', { key, error: String(err?.message ?? err) }); }
  }
  await writeLedger(vault, ledger);
  return { pushed, held };
}
