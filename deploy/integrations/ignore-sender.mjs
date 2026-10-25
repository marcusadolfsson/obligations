#!/usr/bin/env node
/**
 * Silence a sender, from the chat, on his say-so.
 *
 * Alex, 2026-09-15, after the chat refused "Ignore emails from SkyAngel" by
 * pointing him at a button — the second time in a week, after Charity Flights
 * got the same answer: "I need the chat to actually be helpful!"
 *
 * The refusal came from a rule that the ignore list is written only by the
 * Ignore Sender button, so that a standing silence always comes from a click
 * he made rather than a sentence something parsed. rules/capabilities.md left
 * whether the chat could do it as an open question. He has now answered it
 * twice by asking twice, and a question asked twice is a decision.
 *
 * What still holds is the reason the rule existed: the agent reads hostile mail
 * all day, and "ignore your bank" is a plausible thing for a mail to say. So
 * this is ASKS IN CHAT, never unattended:
 *
 *   - it is on NO allow list, so in a chat session it stops at an approval card
 *     that shows the address before anything happens — his tap is the consent;
 *   - in a scheduled job it is refused by canUseTool, which has nobody to ask;
 *   - guards.test.mjs fails if it is ever added to the allow list, because that
 *     one line would hand the silencing of any sender to a run with nobody
 *     watching and an injected mail as its input.
 *
 *   node deploy/integrations/ignore-sender.mjs <address | @domain> --why "…"
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ignoreSender } from '../agent-service/reading.mjs';

const OBLIGATIONS = process.env.OBLIGATIONS ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..');

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const target = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--why');
  const i = argv.indexOf('--why');
  const why = i >= 0 ? argv[i + 1] : '';
  if (!target || !String(why ?? '').trim()) {
    console.error('usage: ignore-sender.mjs <address | @domain> --why "what he asked"');
    process.exit(1);
  }
  try {
    const r = await ignoreSender(OBLIGATIONS, target, { by: 'chat', name: why.slice(0, 80) });
    console.log(`ignored ${target}${r?.archived != null ? ` — ${r.archived} message(s) archived` : ''}`);
    for (const t of r?.tasks ?? []) console.log(`  closed ${t.code ?? t.id} — ${t.title}`);
  } catch (err) {
    // The rule is written before the archive runs, so a failure here usually
    // means the ignore HELD and only the tidy-up did not. Saying "failed" in
    // that case sends him back to do something already done.
    const { ignoredSenders } = await import('../agent-service/reading.mjs');
    const held = (await ignoredSenders(OBLIGATIONS).catch(() => new Set())).has(String(target).toLowerCase());
    console.error(held
      ? `ignored ${target} — future mail is ignored, but archiving what is already there failed: ${err.message.split('\n')[0]}. The next sweep archives it.`
      : `ignore-sender: ${err.message}`);
    process.exit(held ? 0 : 1);
  }
}
