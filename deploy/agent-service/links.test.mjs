/**
 * A pasted Google search URL is 600 characters of tracking parameters. What it
 * renders as is the difference between a readable thread and fifteen lines of
 * base64 — so the label logic is worth testing, and the safety rule (nothing
 * but http/https ever becomes a link) is worth testing more.
 */
import { linkParts, linkLabel } from './web/links.mjs';

let pass = 0, fail = 0;
const ok = (m) => { console.log(`  ok   ${m}`); pass++; };
const bad = (m, d) => { console.log(`  FAIL ${m}${d ? ' -> ' + d : ''}`); fail++; };
const check = (m, c, d) => (c ? ok(m) : bad(m, d));

const links = (t) => linkParts(t).filter((p) => p.type === 'link').map((p) => p.href);

console.log('Finding links');
check('plain text has none', links('hej hoppas allt är bra').length === 0);
check('a bare url is found', links('see https://example.com/x')[0] === 'https://example.com/x');
check('text either side survives',
  linkParts('a https://x.com b').map((p) => p.type).join(',') === 'text,link,text');
check('nothing is lost',
  linkParts('a https://x.com b').map((p) => p.value ?? p.href).join('') === 'a https://x.com b');
check('a sentence-ending period is not part of the url',
  links('go to https://example.com/page.')[0] === 'https://example.com/page',
  links('go to https://example.com/page.')[0]);
check('two links are two links', links('https://a.com and https://b.com').length === 2);

// The whole point of a whitelist: a message can contain any string it likes.
check('javascript: is NOT a link', links('javascript:alert(1)').length === 0);
check('data: is NOT a link', links('data:text/html,<script>x</script>').length === 0);
check('file: is NOT a link', links('file:///etc/passwd').length === 0);

console.log('\nLabelling');
{
  const long = 'https://www.google.com/search?q=eye+dr+in+lecanto+fl&ie=UTF-8&oe=UTF-8'
             + '&hl=en-us&client=safari#sv=CAMSiwMa3wIKBmxjbF9wdhIrCgNwdnESJENnc3ZaeTh4';
  const l = linkLabel(long);
  check('a search shows its query, not its parameters',
    l.title === 'eye dr in lecanto fl' && l.kind === 'search', JSON.stringify(l));
  check('  ...and where it was searched', l.host === 'google.com', l.host);
}
{
  const l = linkLabel('https://www.google.com/search?client=safari&q=Lakeside%20Orthopaedic%20%26%20Joint%20Institute&shem=epsd1');
  check('an escaped query is decoded', l.title === 'Lakeside Orthopaedic & Joint Institute', l.title);
}
{
  const l = linkLabel('https://westcoasteye.com/patients/cataract-surgery.html');
  check('a page uses its last path segment', l.title === 'cataract surgery' && l.kind === 'page', l.title);
}
{
  const l = linkLabel('https://example.com/');
  check('a bare host labels as itself', l.title === 'example.com' && l.kind === 'site', l.title);
}
{
  const l = linkLabel('not a url at all');
  check('junk does not throw', l.kind === 'raw');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
