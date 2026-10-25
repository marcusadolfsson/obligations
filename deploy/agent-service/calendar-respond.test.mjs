/**
 * Answering an invitation: his own entry only, never an event he organizes,
 * and the door is off the jobs' allow list.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withResponse } from '../integrations/calendar-respond.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
let pass = 0, fail = 0;
const check = (m, cond, detail) => {
  if (cond) { console.log(`  ok   ${m}`); pass++; }
  else { console.log(`  FAIL ${m}${detail ? '\n         ' + detail : ''}`); fail++; }
};

console.log('withResponse');
{
  const ev = { organizer: { email: 'owen@riverton.example' }, attendees: [
    { email: 'owen@riverton.example', organizer: true, responseStatus: 'accepted' },
    { email: 'alex@riverton.example', self: true, responseStatus: 'accepted' },
  ] };
  const out = withResponse(ev, 'alex@riverton.example', 'declined', 'Out for Labor Day');
  check('only his entry changes', out[1].responseStatus === 'declined' && out[1].comment === 'Out for Labor Day' && out[0].responseStatus === 'accepted');
  check('everyone else is passed through untouched', out.length === 2 && out[0].email === 'owen@riverton.example');
  let err = null; try { withResponse({ organizer: { self: true }, attendees: [{ self: true }] }, 'm@x', 'declined'); } catch (e) { err = e; }
  check('an event he organizes is refused — that is a cancel', /cancel/.test(err?.message ?? ''));
  err = null; try { withResponse({ organizer: { email: 'a@x' }, attendees: [{ email: 'a@x' }] }, 'alex@x', 'declined'); } catch (e) { err = e; }
  check('an event he is not invited to is refused', /not on this invitation/.test(err?.message ?? ''));
  err = null; try { withResponse(ev, 'alex@riverton.example', 'maybe'); } catch (e) { err = e; }
  check('only the three answers', /accepted, declined, tentative/.test(err?.message ?? ''));
}

console.log('\nfences — chat only, by approval');
{
  const settings = JSON.parse(await readFile(join(REPO, '.claude/settings.json'), 'utf8'));
  const allowed = (settings.permissions?.allow ?? []).filter((r) => r.includes('calendar-respond'));
  check('calendar-respond.mjs is on no allow list — a job cannot answer an invitation', allowed.length === 0, allowed.join(', '));
  let jobs = [];
  for (const f of await readdir(join(REPO, 'jobs'))) if ((await readFile(join(REPO, 'jobs', f), 'utf8')).includes('calendar-respond')) jobs.push(f);
  check('no job prompt names it', jobs.length === 0, jobs.join(', '));
  const src = await readFile(join(REPO, 'deploy/integrations/calendar-respond.mjs'), 'utf8');
  check('it patches attendees and nothing else', /body: JSON\.stringify\(\{ attendees \}\)/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
