/**
 * Handle to name, the one resolver.
 *
 * `integrations/contacts.json` is a **lookup table, not knowledge** — synced
 * from the Mac's address book, mechanical, rebuildable. `people/` is what the
 * repo knows about someone and is curated. Do not confuse them: an address
 * book is everyone whose number you once saved.
 *
 * The match key is the same one `deploy/integrations/handles.py` computes on
 * the Mac — last ten digits of a phone, lowercased address for an email — so a
 * handle written `+1 (727) 555-1234` in one place and `7275551234` in another
 * lands on the same person. Two implementations of that rule, in two languages,
 * and if they drift the symptom is silent: names simply stop resolving.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The handles a `people/` file claims for its person.
 *
 * Alex, 2026-09-21: "lena.ortiz@propmgmt.example is the same person as
 * manager@harborview-condo.example." They are, and nothing here could know it. The
 * index is the Mac's address book and neither address is in it, so the two
 * were two strangers: a chase to one could not see a reply from the other, the
 * People page drew two rows, and `open_elsewhere` could not put their threads
 * together — they do not even share a domain, one being her building and one
 * her employer.
 *
 * `handles:` in the person file is the door, because that file is already
 * where what the assistant KNOWS about someone lives, as against the address book,
 * which is a mechanical table the Mac rebuilds. Writing it there also survives
 * the next sync, which an edit to contacts.json would not.
 *
 *     name: Lena Ortiz
 *     handles: manager@harborview-condo.example, lena.ortiz@propmgmt.example
 *
 * It only ever ADDS names for handles; the file cannot rename someone the Mac
 * already knows under a different handle, because an alias is a claim about
 * one address and never about the rest of the book.
 */
async function peopleHandles(vault) {
  const out = {};
  let files = [];
  try { files = (await readdir(join(vault, 'people'))).filter((f) => f.endsWith('.md') && !f.startsWith('_')); }
  catch { return out; }
  for (const f of files) {
    try {
      const text = await readFile(join(vault, 'people', f), 'utf8');
      const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
      if (!head) continue;
      const field = (k) => new RegExp(`^${k}:\\s*(.+)$`, 'mi').exec(head)?.[1]?.replace(/\s*#.*$/, '').trim() ?? '';
      const name = field('name');
      const handles = field('handles');
      if (!name || !handles) continue;
      for (const h of handles.split(',')) {
        const key = matchKey(h);
        if (key) out[key] = name;
      }
    } catch { /* one unreadable person file must not empty the address book */ }
  }
  return out;
}

/** @returns {Promise<{index: Record<string,string>}>} */
export async function loadContacts(vault) {
  try {
    const d = JSON.parse(await readFile(join(vault, 'integrations', 'contacts.json'), 'utf8'));
    // His `handles:` lines last, so a deliberate claim in a person file beats
    // a stale row in the synced table. See peopleHandles.
    return { index: { ...(d.index ?? {}), ...(await peopleHandles(vault)) } };
  } catch {
    // Not set up, or the Mac has never synced. Handles stay as handles, which
    // is honest; inventing a name would be worse than showing a number. His
    // own aliases still work — they do not live in the file that failed.
    return { index: await peopleHandles(vault) };
  }
}

// A bare phone number, in any of the shapes these files use, and nothing else.
// `+1 (727) 555-1234`, `17275551234`, `+41790000000` — but not a sentence that
// happens to contain one.
const PHONE = /^\+?[\d\s().-]{7,}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The lookup key for a handle, or '' if this is not a handle at all.
 *
 * The second half matters more than the first. `who` is not always a bare
 * handle — the triage writes things like "Hank and +15552000006 (PHOA)" for a
 * group — and stripping non-digits from that yields a number belonging to
 * somebody else entirely. It resolved a group thread to a stranger's name, in
 * a list whose whole purpose is telling Alex who is waiting on him.
 *
 * So: resolve a handle, never a string that contains one.
 */
export function matchKey(handle) {
  const s = String(handle ?? '').trim();
  if (!s) return '';
  if (EMAIL.test(s)) return s.toLowerCase();
  if (!PHONE.test(s)) return '';
  const digits = s.replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

/**
 * The name behind a handle, or null.
 *
 * `me` is passed through untouched: it is a role in a transcript, not someone
 * to look up, and an address book that happened to contain Alex's own number
 * would otherwise rename him mid-conversation.
 */
export function resolveHandle(contacts, handle) {
  if (!handle) return null;
  if (handle === 'me') return 'me';
  const key = matchKey(handle);
  return key ? (contacts.index?.[key] ?? null) : null;
}
