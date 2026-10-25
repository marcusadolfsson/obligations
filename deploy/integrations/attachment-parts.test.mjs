/**
 * What counts as a document, and what is somebody's signature block.
 *
 * Every case here is a real message this got wrong. The rule is cheap to state
 * and has been wrong in both directions twice, which is why it is pinned: a
 * false positive files eight copies of a logo and buries the invoice, and a
 * false negative silently drops a 2.8MB proposal that nothing will ever
 * mention again.
 */
import { isDecoration, attachmentParts, documentParts, DECORATION_BYTES } from './attachment-parts.mjs';

let pass = 0, fail = 0;
const check = (what, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? ` -> ${detail}` : ''}`); }
};

const part = (over = {}) => ({
  filename: 'x.pdf', mimeType: 'application/pdf', body: { size: 400000, attachmentId: 'a1' },
  headers: [], ...over,
});
const withHeaders = (o, h) => part({ ...o, headers: Object.entries(h).map(([name, value]) => ({ name, value })) });

console.log('furniture');
{
  check('a 2KB PNG from a signature block',
        isDecoration(part({ filename: 'image001.png', mimeType: 'image/png', body: { size: 2048, attachmentId: 'a' } })));
  check('a tracking pixel',
        isDecoration(part({ filename: 'p.gif', mimeType: 'image/gif', body: { size: 43, attachmentId: 'a' } })));
  check('a 381KB animated GIF the sender marked inline',
        isDecoration(withHeaders({ filename: 'sig.gif', mimeType: 'image/gif', body: { size: 390144, attachmentId: 'a' } },
                                 { 'Content-Disposition': 'inline; filename=sig.gif' })));
  check('a big logo carrying only a Content-ID',
        isDecoration(withHeaders({ filename: 'logo.png', mimeType: 'image/png', body: { size: 204800, attachmentId: 'a' } },
                                 { 'Content-ID': '<logo@corp>' })));
}

console.log('\ndocuments');
{
  check('a PDF', !isDecoration(part()));
  /* Alex's cabinetry proposal, 2026-09-01: three PDFs of 1.5–2.8MB, every
   * one marked `Content-Disposition: inline` because the sender dragged them
   * into the body in Apple Mail. They are the evidence behind an open #one
   * decision. An inline mark says where it sat on the screen, not what it is. */
  check('a 2.8MB PDF the sender put inline in the body',
        !isDecoration(withHeaders({ filename: 'POAlex.pdf', body: { size: 2887324, attachmentId: 'a' } },
                                  { 'Content-Disposition': 'inline; filename=POAlex.pdf' })),
        'the cabinetry proposal');
  /* 2026-09-16, the PROPA docx: Outlook's forward puts a Content-ID on every
   * part, including ones explicitly marked as attachments. */
  check('a docx carrying a Content-ID and an explicit attachment disposition',
        !isDecoration(withHeaders({ filename: 'x.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', body: { size: 3900000, attachmentId: 'a' } },
                                  { 'Content-ID': '<x@outlook>', 'Content-Disposition': 'attachment; filename=x.docx' })));
  check('a photograph someone actually attached clears the size floor',
        !isDecoration(part({ filename: 'hangar.jpg', mimeType: 'image/jpeg', body: { size: DECORATION_BYTES * 4, attachmentId: 'a' } })));
  check('  ...and a scan just under the floor does not, which is the trade',
        isDecoration(part({ filename: 'scan.png', mimeType: 'image/png', body: { size: DECORATION_BYTES - 1, attachmentId: 'a' } })));
}

console.log('\nwalking a message');
{
  const payload = { parts: [
    { mimeType: 'text/html', body: { size: 900 } },                                   // no filename
    { filename: 'invoice.pdf', mimeType: 'application/pdf', body: { size: 120000, attachmentId: 'a1' }, headers: [] },
    { parts: [
      { filename: 'image001.png', mimeType: 'image/png', body: { size: 1200, attachmentId: 'a2' }, headers: [] },
      { filename: 'image002.png', mimeType: 'image/png', body: { size: 1300, attachmentId: 'a3' }, headers: [] },
    ] },
    { filename: 'nobytes.pdf', mimeType: 'application/pdf', body: { size: 10 } },      // no attachmentId
  ] };
  const all = attachmentParts(payload);
  check('every part with a filename and bytes behind it', all.length === 3, JSON.stringify(all.map((p) => p.filename)));
  check('  ...and the body part and the one with no attachment id are not parts',
        !all.some((p) => /nobytes|html/.test(p.filename ?? '')));
  const docs = documentParts(payload);
  check('one document out of three parts', docs.length === 1 && docs[0].filename === 'invoice.pdf',
        JSON.stringify(docs.map((p) => p.filename)));
  check('the filer gets what it needs from each', docs[0].id === 'a1' && docs[0].bytes === 120000 && docs[0].mime === 'application/pdf');
  check('nothing at all is not a crash', attachmentParts(undefined).length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
