/**
 * Which senders one of Alex's own Gmail filters archives on arrival.
 *
 * `integrations/gmail-filters.xml` is an export of his 132 filters, 122 of which
 * archive. `rules/email-triage.md` treats that as already-ratified: he wrote each
 * one deliberately, and the forwarding target is the name he gave the group.
 *
 * Its own module because two things need it and there must be one parser. The
 * reading list asks which senders are newsletters; the extractor asks whether a
 * thread that is not in the inbox got there by a filter or by Alex's own hand.
 * Those are the same question and a second copy would be the one that drifts.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The newsletter senders, from his filter export.
 *
 * @param target which forwarding address defines the group. `newsletters@` is
 *               reading; `notifications@` and `citialerts@` are digest, and are
 *               read the same way by whatever renders those.
 */
export async function sendersFor(vault, target = 'newsletters@rivera.example') {
  let xml;
  try {
    xml = await readFile(join(vault, 'integrations', 'gmail-filters.xml'), 'utf8');
  } catch {
    return [];      // no export yet; the page says so rather than showing nothing
  }

  const out = new Set();
  // Deliberately not an XML parser. The export is a flat list of <entry> blocks
  // with <apps:property name= value=> children, and a regex over that is less
  // machinery than a dependency in the process that reads his mail.
  for (const entry of xml.split('<entry>').slice(1)) {
    const props = {};
    for (const m of entry.matchAll(/<apps:property name=['"]([^'"]+)['"] value=['"]([^'"]*)['"]/g)) {
      props[m[1]] = m[2];
    }
    if (props.forwardTo !== target || !props.from) continue;
    // `from` is sometimes `Name <addr>` and sometimes a bare address or domain.
    const raw = props.from.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const addr = /<([^>]+)>/.exec(raw)?.[1] ?? raw.replace(/^"|"$/g, '').trim();
    if (addr) out.add(addr);
  }
  return [...out];
}

/**
 * Every sender any archiving filter catches, whatever it forwards to — the set
 * to test "did a filter put this here" against. `sendersFor` answers the
 * narrower question of which group a sender belongs to.
 */
export async function archivedSenders(vault) {
  let xml;
  try {
    xml = await readFile(join(vault, 'integrations', 'gmail-filters.xml'), 'utf8');
  } catch {
    return new Set();
  }
  const out = new Set();
  for (const entry of xml.split('<entry>').slice(1)) {
    const props = {};
    for (const m of entry.matchAll(/<apps:property name=['"]([^'"]+)['"] value=['"]([^'"]*)['"]/g)) {
      props[m[1]] = m[2];
    }
    // shouldArchive is Gmail's "skip the inbox". A filter that only labels is
    // not what puts a thread out of the inbox, so it does not count here.
    if (props.shouldArchive !== 'true' || !props.from) continue;
    const raw = props.from.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    for (const part of raw.split(/\s+OR\s+|,/)) {
      const addr = /<([^>]+)>/.exec(part)?.[1] ?? part.replace(/^"|"$/g, '').trim();
      if (addr) out.add(addr.toLowerCase());
    }
  }
  return out;
}
