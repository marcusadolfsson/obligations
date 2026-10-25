/**
 * The URL is the view.
 *
 * Alex, 2026-09-19: "can we write the url on every load, so you can deeplink
 * to a mail, task etc." An open pane already went in the hash; the filter did
 * not, so /mail always opened on Unseen and no link to "Mail, Action tier"
 * could be written — not by him, not by a brief, not by the chat.
 *
 * The hash is a bag of k=v pairs now, and the thing that must not break is the
 * old single-pair form: every brief, push and note ever written links to
 * `/todo#pane=<id>`.
 */
let pass = 0, fail = 0;
const check = (what, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? ` -> ${detail}` : ''}`); }
};

// A DOM stub with just the two things histate touches.
const entries = [];
globalThis.location = { hash: '', pathname: '/mail', search: '' };
globalThis.history = {
  state: null,
  replaceState(st, _t, url) { this.state = st; entries.push(['replace', url]); apply(url); },
  pushState(st, _t, url) { this.state = st; entries.push(['push', url]); apply(url); },
  back() { entries.push(['back']); },
};
const apply = (url) => { globalThis.location.hash = String(url).startsWith('#') ? String(url) : ''; };
globalThis.addEventListener = () => {};

const { readParams, writeView, openState, stateFromUrl } = await import('./web/histate.mjs');

console.log('reading');
{
  location.hash = '#pane=mail%3Apersonal%3Aabc';
  check('the old single-pair form still reads', stateFromUrl('pane') === 'mail:personal:abc', stateFromUrl('pane'));
  location.hash = '#tier=action&unread=0&pane=x%3Ay';
  const p = readParams();
  check('a bag of pairs reads', p.tier === 'action' && p.unread === '0' && p.pane === 'x:y', JSON.stringify(p));
  check('  ...and one key of it by name', stateFromUrl('tier') === 'action');
  location.hash = '';
  check('no hash is an empty bag, not a crash', Object.keys(readParams()).length === 0);
  location.hash = '#broken';
  check('a hash with no pairs is empty too', Object.keys(readParams()).length === 0);
}

console.log('\nwriting');
{
  location.hash = ''; history.state = null; entries.length = 0;
  writeView({ tier: 'action' });
  check('a view REPLACES — back must not walk through every chip he tried',
        entries[0][0] === 'replace', JSON.stringify(entries[0]));
  check('  ...and lands in the hash', location.hash === '#tier=action', location.hash);
  writeView({ by: 'sender' });
  check('a second write MERGES rather than clobbering',
        readParams().tier === 'action' && readParams().by === 'sender', location.hash);
  writeView({ tier: null });
  check('null takes a key out', !('tier' in readParams()) && readParams().by === 'sender', location.hash);
  writeView({ by: null });
  check('an empty bag writes the bare path, not a dangling #', location.hash === '', JSON.stringify(location.hash));
}

console.log('\nopening a pane');
{
  location.hash = '#tier=action'; history.state = null; entries.length = 0;
  openState('pane', 'mail:a:1');
  check('opening a pane PUSHES — back should close it', entries[0][0] === 'push', JSON.stringify(entries[0]));
  check('  ...and keeps the filter beside it',
        readParams().tier === 'action' && readParams().pane === 'mail:a:1', location.hash);
  openState('pane', 'mail:a:2');
  check('moving between rows REPLACES', entries[1][0] === 'replace', JSON.stringify(entries[1]));
  check('  ...still keeping the filter', readParams().tier === 'action' && readParams().pane === 'mail:a:2');
  writeView({ by: 'sender' });
  check('and writing the view does not close the pane', readParams().pane === 'mail:a:2', location.hash);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
