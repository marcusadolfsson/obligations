/**
 * The relationship graph, assembled from what the system already knows.
 *
 * Alex, 2026-09-05, on the chief-of-staff audit: 492 distinct senders have
 * been judged and 3 have a people/ file. Fifty wrote three or more times and
 * are strangers to the system. Every one of the 872 conclusions carries a `who`
 * — a relationship graph nothing reads.
 *
 * This reads it. A person here is a merge of three things, none of which is
 * rewritten:
 *
 *   people/*.md            what Alex or the compaction wrote about them —
 *                          name, role, org, how he knows them. Authoritative
 *                          for identity when present.
 *   conclusions' `who`     every judged thread names its sender. That is the
 *                          traffic: how often, how recently, what tier.
 *   open obligations       what he owes them, what they owe him — the two
 *                          questions a chief of staff answers walking into a
 *                          room.
 *
 * Derived, never stored. There is no people-index file to drift from the
 * sources; the page and the meeting prep compute it fresh, which at this size is
 * milliseconds.
 *
 * Identity is an address or a phone. Names are unreliable across sources (a
 * mail `who` is an address, an iMessage `who` is a handle, a people/ file has
 * a heading), so the key is the handle and the name is decoration looked up
 * from the file when one exists.
 */
import { isMachine, kindOf } from './handles.mjs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { listOpen } from './obligations.mjs';

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const PHONE = /\+\d{10,15}/g;

/** Lower-cased, trimmed handle. A phone keeps its +, an address its case-folded form. */
export const handle = (s) => String(s ?? '').trim().toLowerCase();

/** Parse one people/*.md into identity + handles. */
function parsePerson(slug, text) {
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  const meta = {};
  for (const line of (fm?.[1] ?? '').split('\n')) {
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (m) meta[m[1]] = m[2].trim();
  }
  const body = text.slice(fm ? fm[0].length : 0);
  const handles = new Set([
    ...(body.match(EMAIL) ?? []).map(handle),
    ...(body.match(PHONE) ?? []),
  ]);
  return {
    slug,
    name: meta.name || slug.replace(/-/g, ' '),
    role: meta.role || '',
    org: meta.org || '',
    lastContact: meta['last-contact'] || '',
    relation: meta.relation || '',
    birthday: meta.birthday || '',
    // `kind: organisation` lets a file opt out of the People page — the one
    // override that runs against the file, because he wrote it.
    kind: /^org/i.test(meta.kind ?? '') ? 'organisation' : 'person',
    handles: [...handles],
    // The first paragraph after the heading is "how I know them" — the one
    // sentence worth carrying into a meeting prep.
    how: (body.match(/\*\*How I know them:\*\*\s*([^\n]+(?:\n(?![\n#-])[^\n]+)*)/)?.[1] ?? '')
      .replace(/\s+/g, ' ').trim(),
  };
}

export async function peopleFiles(vault) {
  const dir = join(vault, 'people');
  let names;
  try { names = (await readdir(dir)).filter((n) => n.endsWith('.md') && !n.startsWith('_')); }
  catch { return []; }
  const out = [];
  for (const n of names) {
    try { out.push(parsePerson(n.slice(0, -3), await readFile(join(dir, n), 'utf8'))); }
    catch { /* one unreadable file must not blank the graph */ }
  }
  return out;
}

/** The Mac's address book, as a map from handle to name. Absent is empty. */
async function contactsFile(vault) {
  try {
    const d = JSON.parse(await readFile(join(vault, 'integrations', 'contacts.json'), 'utf8'));
    const recs = Array.isArray(d) ? d : (d.contacts ?? []);
    return recs.filter((c) => c && c.name);
  } catch { return []; }
}

/** A handle as the index keys it: an address lower-cased, a phone as +1 and its last ten digits. */
const keyOf = (raw) => {
  const s = String(raw ?? '').trim();
  if (s.includes('@')) return handle(s);
  const d = s.replace(/\D/g, '');
  return d.length >= 10 ? '+1' + d.slice(-10) : handle(s);
};

/**
 * Text traffic, from the message triage's judged chats.
 *
 * Alex, 2026-09-22, rethinking the page: the people in his contact book are
 * "more high value" than senders who are not — and those are mostly the people
 * he texts. Until this the page counted mail alone, so Mia and Pete Rourke
 * barely registered while every newsletter sender had a row. Every participant
 * of a chat counts, group chats included: being in a group with someone is
 * being in touch with them.
 */
async function textTraffic(vault) {
  let state;
  try { state = JSON.parse(await readFile(join(vault, 'integrations', 'imessage-state.json'), 'utf8')); }
  catch { return new Map(); }
  const by = new Map();
  for (const t of state.threads ?? []) {
    const when = t.watermark || t.reviewed || '';
    for (const raw of t.participants ?? []) {
      const key = keyOf(raw);
      if (!key) continue;
      if (!by.has(key)) by.set(key, { chats: 0, last: '' });
      const r = by.get(key);
      r.chats += 1;
      if (when > r.last) r.last = when;
    }
  }
  return by;
}

/** Sender traffic from the mail conclusions: count, last seen, tiers. */
async function mailTraffic(vault) {
  let state;
  try { state = JSON.parse(await readFile(join(vault, 'integrations', 'email-state.json'), 'utf8')); }
  catch { return new Map(); }
  const by = new Map();
  for (const t of state.threads ?? []) {
    const c = t.conclusion;
    if (!c?.who) continue;
    const key = handle(c.who);
    if (!by.has(key)) by.set(key, { threads: 0, last: '', tiers: {}, subjects: [] });
    const r = by.get(key);
    r.threads += 1;
    const when = c.since || t.watermark || '';
    if (when > r.last) { r.last = when; r.lastSubject = c.title || c.subject || ''; }
    r.tiers[c.tier] = (r.tiers[c.tier] ?? 0) + 1;
  }
  return by;
}

/**
 * The graph.
 *
 * `who` on an obligation is the counterparty; for a mail obligation it is an
 * address and for an iMessage one a handle, which is why the key is a handle.
 * An obligation with no `who` is nobody's and is not attached.
 */
export async function peopleIndex(vault) {
  const [files, traffic, open, contacts, texts] = await Promise.all([
    peopleFiles(vault), mailTraffic(vault), listOpen(vault).catch(() => []), contactsFile(vault), textTraffic(vault),
  ]);

  // handle -> person, seeded from the files so identity comes from him.
  const byHandle = new Map();
  const persons = new Map();          // slug/handle -> record
  const ensure = (key, seed) => {
    if (!persons.has(key)) {
      persons.set(key, { key, name: '', role: '', org: '', how: '', file: null,
                         handles: [], threads: 0, texts: 0, last: '', lastSubject: '', lastChannel: '', tiers: {},
                         owedByMe: [], owedByThem: [], ...seed });
    }
    return persons.get(key);
  };
  for (const f of files) {
    const p = ensure(f.slug, { name: f.name, role: f.role, org: f.org, how: f.how, relation: f.relation, birthday: f.birthday, fileKind: f.kind,
                               file: `people/${f.slug}.md`, handles: f.handles,
                               last: f.lastContact });
    for (const h of f.handles) byHandle.set(h, p);
  }

  /* Linking an address to a person, in order of trust.
   *
   * 1. The people/ file names the handle itself. Authoritative.
   * 2. The Mac's Contacts (integrations/contacts.json) says the handle belongs
   *    to a name that matches a people/ file's name. Contacts is the address
   *    book — "everyone whose number you once saved" — so it is not knowledge,
   *    but it IS a reliable map from handle to name, which is exactly what is
   *    needed here. A person with a file also inherits their other Contacts
   *    handles, so admin@harborview-condo.example reaches Kyle Porter's page.
   * 3. First name, ONLY with corroboration: the local part matches the file's
   *    first name AND the address domain contains the file's org. Hank's file
   *    says org PHOA, so hank@phoa.example links. Alex, 2026-09-05: "these are
   *    separate people" — kyle@saunaco.example had been linked to Kyle Porter
   *    (the locks business, no org) because "chris" matched exactly one file.
   *    A wrong link puts one person's debts on another's page, which is worse
   *    than no link, so a bare first name is no longer enough.
   */
  const byName = new Map(files.map((f) => [f.name.toLowerCase(), persons.get(f.slug)]));
  const contactName = new Map();          // handle -> contact name (lower)
  for (const c of contacts) {
    for (const h of c.handles ?? []) {
      const key = h.kind === 'email' ? handle(h.key ?? h.raw) : '+1' + String(h.key ?? '').replace(/\D/g, '').slice(-10);
      if (key) contactName.set(key, c.name.toLowerCase());
    }
    // A file with the same name inherits the contact's handles.
    const p = byName.get(c.name.toLowerCase());
    if (p) for (const h of c.handles ?? []) {
      const key = h.kind === 'email' ? handle(h.key ?? h.raw) : '+1' + String(h.key ?? '').replace(/\D/g, '').slice(-10);
      if (key && !byHandle.has(key)) { p.handles.push(key); byHandle.set(key, p); }
    }
  }
  const slugOf = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const linkByName = (h) => {
    // 2. Contacts knows this handle, and the name has a file.
    const cn = contactName.get(h);
    if (cn && byName.has(cn)) { const p = byName.get(cn); p.handles.push(h); byHandle.set(h, p); return p; }
    /* 2b. The name on their own mail is exactly a people/ file's name. Ruth
       Ellis has a file, and wrote from ruth@coc624.example, which
       the file does not list — so the rethink of 2026-09-22 showed her twice,
       once in each circle. A full name that matches a file he keeps is the
       same person often enough to join; a first name alone is not (see 3). */
    const dn = displayNames.get(h)?.replace(/\s+/g, ' ').trim().toLowerCase();
    if (dn && dn.includes(' ') && byName.has(dn)) { const p = byName.get(dn); p.handles.push(h); byHandle.set(h, p); return p; }
    // 3. first name + org domain.
    const at = h.indexOf('@');
    if (at < 0) return null;
    const local = h.slice(0, at), domain = h.slice(at + 1);
    for (const f of files) {
      const first = f.name.toLowerCase().split(/\s+/)[0];
      const org = slugOf(f.org);
      if (first.length >= 3 && local === first && org.length >= 3 && slugOf(domain).includes(org)) {
        const p = persons.get(f.slug); p.handles.push(h); byHandle.set(h, p); return p;
      }
    }
    return null;
  };

  /* Traffic attaches to a known person, or becomes a person of its own. When
   * it does, Contacts names it: an unfiled sender the address book knows shows
   * as "Nadia Volkov", not nadia@crestline.example, and two addresses saved on
   * one contact become one row. This is the whole of what "sync the address
   * book" should mean here (Alex, 2026-09-05) — names on rows, not a
   * thousand stub files that would bury the eighteen real ones and make the
   * mail differ's "a person he knows" signal fire for every plumber he ever
   * saved. */
  const contactRow = (h) => {
    const cn = contactName.get(h);
    if (!cn) return null;
    const key = 'contact:' + cn.replace(/[^a-z0-9]+/g, '-');
    const c = contacts.find((x) => x.name.toLowerCase() === cn);
    /* What the card says it is, once the Mac exports it — see
       inbox/2026-09-22-mac-contacts-company-flag.md. Absent until then, and
       absent means "a card with a name", which is a person. */
    const p = ensure(key, { name: c?.name ?? cn, handles: [], contact: true,
                            isCompany: !!c?.is_company, org: c?.org ?? '', role: c?.job_title ?? '' });
    for (const ch of c?.handles ?? []) {
      const k = ch.kind === 'email' ? handle(ch.key ?? ch.raw) : '+1' + String(ch.key ?? '').replace(/\D/g, '').slice(-10);
      if (k && !p.handles.includes(k)) { p.handles.push(k); byHandle.set(k, p); }
    }
    if (!p.handles.includes(h)) { p.handles.push(h); byHandle.set(h, p); }
    return p;
  };
  // A machine is not a person. noreply@github.com creating an obligation is
  // still an obligation on Work; it is not someone Alex knows. Alex,
  // 2026-09-06: "Why does people have so many emails not related to people?"
  // A machine address with a people/ file or a Contacts name still shows.
  let machinesHidden = 0;
  const machine = (h) => isMachine(h) && !byHandle.get(h) && !linkByName(h) && !contactName.get(h);
  // The display name the mail itself carried, when nothing better exists.
  // Precedence stays: a people/ file, then Contacts, then this, then the bare
  // address. Alex, 2026-09-07: "why do we show the email address instead of
  // the person's name?" — 395 of 507 rows were addresses.
  const displayNames = new Map();
  try {
    // The accumulated map first — it outlives the 14-day extract window.
    const d = JSON.parse(await readFile(join(vault, 'integrations', 'sender-names.json'), 'utf8'));
    for (const [a, n] of Object.entries(d.names ?? {})) displayNames.set(handle(a), n);
  } catch { /* not built yet */ }
  try {
    const ex = JSON.parse(await readFile(join(vault, 'integrations', 'gmail.json'), 'utf8'));
    for (const t of ex.threads ?? []) {
      for (const m of t.messages ?? []) {
        const a = handle(m.from);
        if (a && m.from_name && !displayNames.has(a)) displayNames.set(a, m.from_name);
      }
    }
  } catch { /* no extract: addresses it is, and the count below says so */ }

  for (const [h, r] of traffic) {
    if (machine(h)) { machinesHidden++; continue; }
    const p = byHandle.get(h) ?? linkByName(h) ?? contactRow(h)
      ?? ensure(h, { name: displayNames.get(h) ?? h, handles: [h], namedByMail: !!displayNames.get(h) });
    if (!byHandle.has(h)) byHandle.set(h, p);
    p.threads += r.threads;
    if (r.last > p.last) { p.last = r.last; p.lastSubject = r.lastSubject ?? ''; p.lastChannel = 'email'; }
    for (const [t, n] of Object.entries(r.tiers)) p.tiers[t] = (p.tiers[t] ?? 0) + n;
  }

  // Texts, on the same terms as mail: to a known person, a contact, or a row
  // of its own. A number nobody can name is still someone texting him.
  for (const [h, r] of texts) {
    if (machine(h)) continue;
    const p = byHandle.get(h) ?? linkByName(h) ?? contactRow(h) ?? ensure(h, { name: h, handles: [h] });
    if (!byHandle.has(h)) byHandle.set(h, p);
    p.texts += r.chats;
    if (r.last > p.last) { p.last = r.last; p.lastChannel = 'text'; }
  }

  /* A COUNTERPARTY WRITTEN AS A NAME. The message triage names people, so an
   * obligation's `who` is often "Kyle Porter" or "Carl (Brava), Rudy Lamb"
   * rather than a handle. Joined on handles alone, every one became a second,
   * lower-cased row beside the person's real one — the rethink of 2026-09-22
   * found chris johnson, tom rourke, lena ortiz and dana rivera listed
   * twice. A name resolves to a people/ file, then to a contact card; a label
   * naming several people attaches the debt to each one it can name. */
  const contactHandleByName = new Map();
  for (const c of contacts) {
    const first = (c.handles ?? [])[0];
    if (!first) continue;
    const k = first.kind === 'email' ? handle(first.key ?? first.raw) : '+1' + String(first.key ?? '').replace(/\D/g, '').slice(-10);
    if (k && !contactHandleByName.has(c.name.toLowerCase())) contactHandleByName.set(c.name.toLowerCase(), k);
  }
  const byPersonName = (label) => {
    const n = label.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!n) return null;
    if (byName.has(n)) return byName.get(n);
    const ch = contactHandleByName.get(n);
    return ch ? (byHandle.get(ch) ?? contactRow(ch)) : null;
  };
  const nameParts = (who) => String(who).split(/\s*(?:,|;|\band\b|&|\+)\s*/i).map((x) => x.trim()).filter(Boolean);

  // Open obligations, both directions.
  for (const o of open) {
    const h = handle(o.who);
    if (!h) continue;
    if (machine(h)) continue;
    const row = { id: o.id, title: o.title, days: o.days, due: o.due ?? null, overdue: !!o.overdue };
    const isHandle = h.includes('@') || /^\+?\d[\d\s().-]{6,}$/.test(h);
    let targets = [];
    if (isHandle) {
      targets = [byHandle.get(h) ?? linkByName(h) ?? contactRow(h) ?? ensure(h, { name: o.who, handles: [h] })];
    } else {
      targets = nameParts(o.who).map(byPersonName).filter(Boolean);
      // Nobody it can name: one row under the label as written, which the
      // classifier then judges like any other. Never lower-cased — the case
      // is part of how a name is told from a brand.
      if (!targets.length) targets = [byHandle.get(h) ?? ensure(h, { name: String(o.who).trim(), handles: [h] })];
    }
    for (const p of new Set(targets)) {
      if (isHandle && !byHandle.has(h)) byHandle.set(h, p);
      (o.owed_by === 'them' ? p.owedByThem : p.owedByMe).push(row);
    }
  }

  /* PEOPLE ONLY, YOURS FIRST. Alex, 2026-09-22: "Lets make it people only
   * to begin with, it has a lot of organizations in there. … those [in the
   * contact book] should be more high value people than non-contact book
   * people."
   *
   * `kind` from the one classifier, trusting what names people: a people/
   * file is a person unless it says otherwise, a contact card is a person
   * unless its name is unmistakably a company's (or, once the Mac exports it,
   * the card is flagged as one). Everything else is judged by its address
   * and the name on its own mail. `circle` is the split he asked for.
   *
   * Organisations and machines leave the list and are counted, so a shorter
   * page and a broken one do not look the same. */
  let orgsHidden = 0;
  const hiddenRows = [];
  const active = [...persons.values()]
    .filter((p) => p.file || p.threads || p.texts || p.owedByMe.length || p.owedByThem.length);
  for (const p of active) {
    p.kind = p.file ? (p.fileKind ?? 'person')
      : p.contact ? kindOf(null, { name: p.name, trusted: true, isCompany: p.isCompany })
      : p.handles.map((h) => kindOf(h, { name: p.name })).find((k) => k !== 'person')
        ?? kindOf(p.key, { name: p.name });
    p.circle = p.file || p.contact ? 'yours' : 'others';
  }
  const hasOpen = (p) => (p.owedByMe.length || p.owedByThem.length ? 1 : 0);
  const list = active
    .filter((p) => { if (p.kind === 'person') return true; orgsHidden++; hiddenRows.push(p); return false; })
    // Yours before others, something open before nothing, then most recent.
    .sort((a, b) => (a.circle === b.circle ? 0 : a.circle === 'yours' ? -1 : 1)
      || hasOpen(b) - hasOpen(a) || (b.last || '').localeCompare(a.last || ''));

  return {
    people: list,
    // Not drawn. Kept on the result so a spot-check can see what was left off
    // and why, without a second classifier to disagree with this one.
    hidden: hiddenRows.map((p) => ({ key: p.key, name: p.name, kind: p.kind, threads: p.threads, texts: p.texts })),
    counts: {
      total: list.length,
      withFile: list.filter((p) => p.file).length,
      // The audit's number, kept live: repeat senders the system has no file for.
      repeatWithoutFile: list.filter((p) => !p.file && p.threads >= 3).length,
      withOpen: list.filter((p) => p.owedByMe.length || p.owedByThem.length).length,
      // The two circles, and what was left off for not being a person.
      yours: list.filter((p) => p.circle === 'yours').length,
      others: list.filter((p) => p.circle === 'others').length,
      orgsHidden,
      // Named by the address book rather than by a file — the sync, as a number.
      namedByContacts: list.filter((p) => p.contact).length,
      // Named by the display name on their own mail, having no file and no contact.
      namedByMail: list.filter((p) => p.namedByMail).length,
      // Senders left off because the address is a machine's — a number, so a
      // page with fewer rows and a broken graph do not look the same.
      machinesHidden,
    },
  };
}

/** One person by any handle, or null. What the meeting prep asks. */
export async function personFor(vault, who) {
  const h = handle(who);
  if (!h) return null;
  const { people } = await peopleIndex(vault);
  return people.find((p) => p.handles.includes(h) || p.key === h) ?? null;
}
