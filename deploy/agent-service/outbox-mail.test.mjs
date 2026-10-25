/**
 * The mail half of the outbox: reading a draft's body, the page's shape, the
 * record a send leaves, and — the part that matters — that nothing without a
 * signed-in person behind it can send.
 */
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { plainText, shapeDraft, sendDraft, attachmentsOf } from '../integrations/mail-drafts.mjs';
import { listOutbox, setText, recordMailSent } from './outbox.mjs';
import { fetchDriveFile } from '../integrations/drive-fetch.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
let pass = 0, fail = 0;
const check = (m, cond, detail) => {
  if (cond) { console.log(`  ok   ${m}`); pass++; }
  else { console.log(`  FAIL ${m}${detail ? '\n         ' + detail : ''}`); fail++; }
};
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');

console.log('plainText — the readable body of a Gmail payload');
{
  const nested = { mimeType: 'multipart/mixed', parts: [
    { mimeType: 'multipart/alternative', parts: [
      { mimeType: 'text/plain', body: { data: b64('Hello there\r\n\r\nAlex') } },
      { mimeType: 'text/html', body: { data: b64('<p>Hello there</p><p>Alex</p>') } },
    ] },
    { mimeType: 'application/pdf', body: { attachmentId: 'x' } },
  ] };
  check('text/plain wins, nested two deep, CRLF folded', plainText(nested) === 'Hello there\n\nAlex', JSON.stringify(plainText(nested)));
  const htmlOnly = { mimeType: 'text/html', body: { data: b64('<div>Hi <b>you</b><br>bye &amp; thanks</div>') } };
  check('HTML-only falls back to stripped text', plainText(htmlOnly) === 'Hi you\nbye & thanks', JSON.stringify(plainText(htmlOnly)));
  const ent = { mimeType: 'text/html', body: { data: b64('<div>what&#39;s needed &quot;now&quot; &#x2014; ok</div>') } };
  check('numeric and named entities are decoded (a live draft showed &#39;)', plainText(ent) === 'what\'s needed "now" — ok', JSON.stringify(plainText(ent)));
  check('no body is an empty string, not a throw', plainText(undefined) === '' && plainText({}) === '');
}

console.log('\nshapeDraft — the page\'s shape');
{
  const d = { id: 'r-1', message: { id: 'm1', threadId: 't1', internalDate: '1757100000000', snippet: 'Thanks', payload: {
    headers: [{ name: 'To', value: 'A <a@x.com>' }, { name: 'subject', value: 'Re: Quote' }, { name: 'In-Reply-To', value: '<q@x>' }],
    mimeType: 'text/plain', body: { data: b64('Thanks — go ahead.') } } } };
  const s = shapeDraft(d, 'personal', { canSend: true });
  check('kind, id, account, canSend', s.kind === 'mail' && s.id === 'r-1' && s.account === 'personal' && s.canSend === true);
  check('headers are read case-insensitively', s.to === 'A <a@x.com>' && s.subject === 'Re: Quote' && s.inReplyTo === '<q@x>');
  check('body and updatedMs', s.text === 'Thanks — go ahead.' && s.updatedMs === 1757100000000);
  check('a Gmail link to the draft', s.link.includes('#drafts/m1'));
  check('no subject reads as (no subject)', shapeDraft({ id: 'r', message: { payload: { headers: [] } } }, 'work').subject === '(no subject)');
  const mixed = { mimeType: 'multipart/mixed', parts: [{ mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: b64('hi') } }] }, { mimeType: 'application/pdf', filename: 'cert.pdf', body: { attachmentId: 'att1', size: 77216 } }] };
  const files = attachmentsOf(mixed);
  check('attachments are found by filename and id, wherever they sit', files.length === 1 && files[0].filename === 'cert.pdf' && files[0].attachmentId === 'att1' && files[0].size === 77216);
  check('the page shape lists them without the id', shapeDraft({ id: 'r', message: { payload: mixed } }, 'personal').attachments[0].filename === 'cert.pdf' && !('attachmentId' in shapeDraft({ id: 'r', message: { payload: mixed } }, 'personal').attachments[0]));
}

console.log('\nsendDraft — nobody behind the request, nothing leaves');
{
  let err = null;
  try { await sendDraft(REPO, 'personal', 'r-1', {}); } catch (e) { err = e; }
  check('refuses without who, before any network', /signed-in identity/.test(err?.message ?? ''), err?.message);
  err = null;
  try { await sendDraft(REPO, 'personal', 'r-1', { who: 'agent:mail' }); } catch (e) { err = e; }
  check('an agent name is not an identity', /signed-in identity/.test(err?.message ?? ''), err?.message);
}

console.log('\nfences — the send door has no handle a job can reach');
{
  const src = await readFile(join(REPO, 'deploy/integrations/mail-drafts.mjs'), 'utf8');
  check('mail-drafts.mjs has no CLI (no process.argv)', !/process\.argv/.test(src));
  const settings = JSON.parse(await readFile(join(REPO, '.claude/settings.json'), 'utf8'));
  const allowed = (settings.permissions?.allow ?? []).filter((r) => r.includes('mail-drafts'));
  check('it is on no allow list', allowed.length === 0, allowed.join(', '));
  let jobsMention = [];
  for (const f of await readdir(join(REPO, 'jobs'))) {
    if ((await readFile(join(REPO, 'jobs', f), 'utf8')).includes('mail-drafts')) jobsMention.push(f);
  }
  check('no job prompt names it', jobsMention.length === 0, jobsMention.join(', '));
  const server = await readFile(join(REPO, 'deploy/agent-service/server.mjs'), 'utf8');
  const route = server.slice(server.indexOf("'/api/outbox/mail/send'"));
  check('the send route checks who?.email before reading the body',
        route.indexOf('who?.email') < route.indexOf('readJson') && route.indexOf('403') < route.indexOf('sendDraft('));
  // 2026-10-15: the pane's Send read draft.id, a field draftReply never
  // returns, and asked Gmail for drafts/undefined on every tap.
  const reply = server.slice(server.indexOf("'/api/mail/reply'"), server.indexOf("'/api/mail/reply'") + 3000);
  check('the pane reply sends the id draftReply returns (draftId)',
        /draft\?\.draftId/.test(reply) && !/draft\.id\b/.test(reply));
}

console.log('\noutbox/ — the record a send leaves, and an edit before approval');
{
  const dir = await mkdtemp(join(tmpdir(), 'outbox-'));
  await writeFile(join(dir, '2026-09-05-1815-chris.md'),
    '---\ntype: outbox\nto: +17275550000\nchat_id: any;-;+17275550000\nstatus: draft\ncreated: 2026-09-05 18:15\napproved_at: -\nsent_at: -\nerror: -\n---\n\nKyle — any progress?\n');
  const rec = await recordMailSent(dir, { to: 'Vendor <v@x.com>', cc: null, subject: 'Re: Quote', account: 'personal', draftId: 'r-1', messageId: 'm9', threadId: 't1', who: 'alex@rivera.example', text: 'Go ahead.' });
  check('record is named by stamp and subject', /^\d{4}-\d{2}-\d{2}-\d{4}-mail-quote\.md$/.test(rec.id), rec.id);
  const all = await listOutbox(dir);
  const mail = all.find((x) => x.kind === 'mail');
  check('listOutbox reads it back as kind mail, status sent, with who approved',
        mail && mail.status === 'sent' && mail.subject === 'Re: Quote' && mail.account === 'personal' && /by alex@rivera\.example/.test(mail.approvedAt ?? ''), JSON.stringify(mail));
  check('the text draft is kind text', all.find((x) => x.id === '2026-09-05-1815-chris.md')?.kind === 'text');
  const e = await setText(dir, '2026-09-05-1815-chris.md', 'Kyle — where did the NTM645 units come from?', 'alex@rivera.example');
  const after = (await listOutbox(dir)).find((x) => x.id === '2026-09-05-1815-chris.md');
  check('an edit replaces the body and records who', after.text === 'Kyle — where did the NTM645 units come from?' && /by alex/.test(after.editedAt ?? '') && after.status === 'draft', JSON.stringify(after));
  let err = null; try { await setText(dir, '2026-09-05-1815-chris.md', '   ', 'x'); } catch (x) { err = x; }
  check('an empty edit is refused', /discard/.test(err?.message ?? ''));
  err = null; try { await setText(dir, rec.id, 'nope', 'x'); } catch (x) { err = x; }
  check('a sent record cannot be edited', /already sent/.test(err?.message ?? ''), err?.message);
  await rm(dir, { recursive: true, force: true });
}

console.log('\ndrive-fetch — a file id, the assistant\'s grant, disk');
{
  let err = null; try { await fetchDriveFile(REPO, 'nope'); } catch (e) { err = e; }
  check('a bad id is refused before any network', /Drive file id/.test(err?.message ?? ''));
  const settings = JSON.parse(await readFile(join(REPO, '.claude/settings.json'), 'utf8'));
  check('drive-fetch is allowed (read-only, own grant) and mail-drafts.mjs still is not',
        settings.permissions.allow.some((r) => r.includes('drive-fetch.mjs')) && !settings.permissions.allow.some((r) => r.includes('mail-drafts')));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
