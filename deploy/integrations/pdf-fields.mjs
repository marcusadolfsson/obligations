#!/usr/bin/env node
/**
 * Read the labelled fields off an invoice PDF — due date, terms, number, total.
 *
 * Alex, 2026-09-09, on the Lakeside Jet Hangar Co invoice that sat three weeks
 * with no due date on it: "can we parse the PDF and look for a bill due date?
 * and incorporate that in emails that look like invoices?"
 *
 * The invoice said *Payment Terms: Due On Receipt* and *Invoice Date:
 * 08/19/2026*. The triage never saw either, because `file-attachment.mjs`
 * uploads bytes and never opens them, and the mail body said nothing. So the
 * obligation carried `due: null`, sat in the no-date bucket, and only surfaced
 * when the vendor chased.
 *
 * ## This does not decide anything
 *
 * It reports **the strings it found**. A date printed against a "Due Date"
 * label is transcribed to ISO, because reading a date off a page is
 * transcription. Terms are reported verbatim and `dueDate` is left null,
 * because turning "Due On Receipt" or "Net 30" into a day is a judgement about
 * a debt, and judgement belongs to the triage — which already sets `due`, and
 * which can see the invoice date sitting next to the terms.
 *
 * A regex that quietly sets a deadline is the failure this repo keeps
 * designing against: a wrong due date and a missing one look identical
 * afterwards, and only one of them is safe.
 *
 * ## Getting the text out, with no dependency
 *
 * There is no `pdftotext` on the host, no `node_modules`, and the repo is
 * stdlib-only on purpose. But the filer already holds `drive.file` — it may
 * manage the files it created. So: copy the uploaded PDF into a Google Doc,
 * which converts it, export that as text/plain, delete the temp Doc. Three
 * API calls and nothing new installed.
 *
 * **An image-only PDF comes back with no text**, and that is reported as
 * `blind` rather than as an absence of fields. ARKO's cabinetry quote is one:
 * its export is the literal string "Page 1 of 2\n\nPage 2 of 2". "This invoice
 * has no due date" and "I could not read this invoice" must never look the
 * same.
 *
 * The round trip itself is in `file-attachment.mjs` — see the note at the
 * bottom of this file on why the network is not here.
 *
 *   node deploy/integrations/pdf-fields.mjs --text-file some.txt   # parse only
 */

/** A date as invoices print them. Anchored to a label; never matched loose. */
const DATE = String.raw`(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|[A-Z][a-z]{2,8}\.?\s+\d{1,2},?\s+\d{4})`;

/**
 * The gap a label tolerates before its value.
 *
 * Not `\s*`. PDF text extraction reads by column, so a label and its figure can
 * come out separated by blank lines — the Lakeside invoice yields
 * "Subtotal:\n\nTotal:\n\n1,535.13 USD". Bounded, so a label never reaches
 * across the page and claims an unrelated number.
 */
const GAP = String.raw`[\s:\-]{0,40}`;

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
                 jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

const p2 = (n) => String(n).padStart(2, '0');

/**
 * A printed date to `YYYY-MM-DD`, or null if it is not one.
 *
 * US order (MM/DD/YYYY) for slashed dates, because every invoice in this repo
 * is from a US vendor. A two-digit year is 20xx. Anything that does not make a
 * real calendar day returns null rather than a guess — 13/40/2026 is a parse
 * failure, not a date.
 */
export function isoDate(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;

  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return validDay(+m[1], +m[2], +m[3]);

  m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
  if (m) {
    const year = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return validDay(year, +m[1], +m[2]);
  }

  m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
    return mon ? validDay(+m[3], mon, +m[2]) : null;
  }
  return null;
}

function validDay(y, mo, d) {
  if (!(y >= 1990 && y <= 2100) || !(mo >= 1 && mo <= 12) || !(d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() + 1 !== mo || dt.getUTCDate() !== d) return null;
  return `${y}-${p2(mo)}-${p2(d)}`;
}

const first = (text, re) => text.match(re)?.[1]?.trim() ?? null;

/**
 * Every labelled currency amount in the document, largest first.
 *
 * "Total" appears once per line item on a work-order invoice, so the last one
 * is not reliably the bill and neither is the first. The largest is, for the
 * shape of document this reads — and `totalCandidates` carries how many were
 * seen, so an ambiguous read is visible instead of silent.
 */
export function amounts(text) {
  const re = new RegExp(
    String.raw`(?:amount\s*due|balance\s*due|invoice\s*total|total\s*due|grand\s*total|total)`
    + GAP + String.raw`(?:USD|\$)?\s*([\d]{1,3}(?:,\d{3})*\.\d{2})`,
    'gi');
  const out = [];
  for (const m of text.matchAll(re)) out.push(Number(m[1].replace(/,/g, '')));
  return [...new Set(out)].sort((a, b) => b - a);
}

/**
 * The labelled fields, as found. Nothing here is computed or inferred.
 *
 * `dueDate` is set only when the page carries a date against a due-date label.
 * `terms` is verbatim; resolving it is the triage's job.
 */
export function fields(text) {
  const t = String(text ?? '');

  // Under ~200 characters of extracted text means no text layer worth reading:
  // a scanned or image-only PDF. Report it, never treat it as "no fields".
  if (t.replace(/\s+/g, '').length < 200) {
    return { blind: 'no text layer — image-only PDF', chars: t.length };
  }

  const dueRaw = first(t, new RegExp(
    String.raw`(?:due\s*date|date\s*due|payment\s*due(?:\s*(?:date|by))?)` + GAP + DATE, 'i'));
  const invDateRaw = first(t, new RegExp(
    String.raw`(?:invoice\s*date|date\s*of\s*invoice|statement\s*date)` + GAP + DATE, 'i'));

  const termsRaw = first(t, /(?:payment\s*)?terms\s*[:\-]?[ \t]*([^\n]{1,48})/i);
  const netDays = first(t, /\bnet\s*(\d{1,3})\b/i);
  const onReceipt = /\bdue\s+(?:up)?on\s+receipt\b/i.test(t) ? 'due on receipt' : null;

  const totals = amounts(t);

  return {
    invoiceNumber: first(t, /invoice\s*(?:number|no\.?|#)\s*[:\-]?[ \t]*([A-Z0-9][A-Z0-9\/-]{2,24})/i),
    invoiceDate: isoDate(invDateRaw),
    dueDate: isoDate(dueRaw),
    terms: onReceipt ?? (netDays ? `net ${netDays}` : termsRaw?.replace(/\s+/g, ' ') ?? null),
    total: totals[0] ?? null,
    totalCandidates: totals.length,
    chars: t.length,
  };
}

/** True if a document looks like a bill at all. Keeps the noise off other PDFs. */
export function looksLikeInvoice(f) {
  if (!f || f.blind) return false;
  return Boolean(f.invoiceNumber || f.dueDate || f.terms || f.total);
}

/** One line for `reference/statements.md`, or '' when there is nothing to add. */
export function fieldsLine(f) {
  if (!f) return '';
  if (f.blind) return ' · unread: no text layer';
  const bits = [];
  if (f.invoiceNumber) bits.push(f.invoiceNumber);
  if (f.total != null) {
    bits.push(`$${f.total.toLocaleString('en-US', { minimumFractionDigits: 2 })}`
              + (f.totalCandidates > 1 ? ` (${f.totalCandidates} totals on the page)` : ''));
  }
  if (f.dueDate) bits.push(`due ${f.dueDate}`);
  else if (f.terms) bits.push(`terms: ${f.terms}`);
  if (f.invoiceDate && !f.dueDate) bits.push(`invoiced ${f.invoiceDate}`);
  return bits.length ? ` · ${bits.join(' · ')}` : '';
}

/**
 * There is deliberately no network here.
 *
 * Getting the text out needs a Drive token, and the only thing that holds one
 * is `file-attachment.mjs`, which is already authenticated and already holds
 * the uploaded file's id. So the round trip lives there and this module stays
 * pure — which is what lets the whole of it be tested against real invoices
 * with nothing stubbed.
 */

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf('--text-file');
  if (i < 0) {
    console.error('usage: pdf-fields.mjs --text-file <path>');
    process.exit(2);
  }
  const { readFile } = await import('node:fs/promises');
  const f = fields(await readFile(process.argv[i + 1], 'utf8'));
  console.log(JSON.stringify(f, null, 2));
  console.log(`line:${fieldsLine(f)}`);
}
