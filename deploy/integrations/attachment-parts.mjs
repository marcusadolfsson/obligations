/**
 * Which parts of a Gmail message are documents, and which are furniture.
 *
 * Extracted from `file-attachment.mjs` on 2026-09-19 so the filing half and the
 * tidy-up half cannot disagree. Alex, looking at the documents list on
 * /reference: "can we clean up the older documents that are only email inbody
 * images. I think we stopped saving new ones but not previous imports." He was
 * right on both counts — and the only safe way to decide what a line filed in
 * August would be called today is to ask the same function, not a copy of it
 * written from the same description.
 */

export const header = (headers, name) => (headers ?? [])
  .find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

/** Under this, an image is a signature logo rather than a document. */
export const DECORATION_BYTES = 20 * 1024;

/**
 * A signature logo or a tracking pixel, not a document.
 *
 * Alex, 2026-09-09, looking for the Lakeside Jet Hangar Co invoice: it was filed,
 * and so were eight 1–2KB PNGs from the sender's signature block, so the two
 * real PDFs came tenth and ninth in `reference/statements.md`. Every part with
 * a filename and an attachment id was treated as a document.
 *
 * Two marks, either of which is enough: the part is referenced from the HTML
 * body (`Content-Disposition: inline`, or it carries a Content-ID with no
 * explicit `attachment` disposition), or it is a small image. A real
 * photograph someone attached clears the size floor; a logo never does.
 *
 * Found 2026-09-16, filing the PROPA docx: some mail clients (Outlook's
 * forward, here) put a `Content-ID` on every part, including ones marked
 * `Content-Disposition: attachment` — a genuine 3.9MB document was silently
 * skipped because it carried both. An explicit `attachment` disposition is
 * the sender saying what this is; a `Content-ID` alone is not enough to
 * override it.
 *
 * The size floor is what the inline marks cannot catch on their own: a 381KB
 * animated GIF in a corporate signature block carries neither mark in some
 * senders' mail, and twelve of those were filed as documents before this
 * existed.
 */
export function isDecoration(part) {
  // Only an image can be furniture, whatever the headers say. Found 2026-09-19,
  // writing the tidy: Omar's cabinetry proposal — three PDFs of 1.5MB, 2.8MB
  // and 2.8MB, and the evidence behind an open #one decision — arrived with
  // `Content-Disposition: inline` on every part, which is what Apple Mail does
  // when the sender drags a file into the body. The rule as written called all
  // three decoration, so they were filed only because they predate it and the
  // filer would skip them today. An inline mark says where the sender put it on
  // the screen; it does not say the thing is a logo.
  const mime = String(part.mimeType ?? '');
  if (!mime.startsWith('image/')) return false;
  const h = part.headers ?? [];
  const disposition = header(h, 'Content-Disposition').toLowerCase();
  if (disposition.startsWith('inline')) return true;
  if (header(h, 'Content-ID') && !disposition.startsWith('attachment')) return true;
  return (part.body?.size ?? 0) < DECORATION_BYTES;
}

/**
 * Every part of a message that has a filename and bytes behind it, each marked
 * as a document or as decoration. Depth-first, so the order matches the order
 * the filer walked them in — which is what lets an old record line be matched
 * back to the part it came from.
 */
export function attachmentParts(payload) {
  const out = [];
  const walk = (part) => {
    if (!part) return;
    if (part.filename && part.body?.attachmentId) {
      out.push({
        filename: part.filename,
        mime: part.mimeType,
        bytes: part.body.size ?? 0,
        id: part.body.attachmentId,
        decoration: isDecoration(part),
      });
    }
    for (const c of part.parts ?? []) walk(c);
  };
  walk(payload);
  return out;
}

/** The parts worth filing. */
export const documentParts = (payload) => attachmentParts(payload).filter((p) => !p.decoration);
