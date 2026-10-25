/**
 * Invoice field extraction.
 *
 * The fixture is the real Lakeside Jet Hangar Co invoice — the document that named
 * this feature. It sat three weeks with `due: null` on it while the PDF said
 * "Payment Terms: Due On Receipt" and "Invoice Date: 08/19/2026", because
 * nothing ever opened the file.
 *
 * Two properties matter more than the happy path:
 *
 *   - **A date is never invented.** Terms leave `dueDate` null on purpose; the
 *     triage resolves them with the invoice date in front of it. A regex that
 *     silently sets a deadline produces a wrong due date that looks exactly
 *     like a right one.
 *   - **Unreadable is not empty.** An image-only PDF reports `blind`. The
 *     repo's oldest failure shape is a silence indistinguishable from success.
 */
import { fields, fieldsLine, isoDate, amounts, looksLikeInvoice } from './pdf-fields.mjs';

let pass = 0, fail = 0;
const check = (m, cond, detail) => {
  if (cond) { console.log(`  ok   ${m}`); pass++; }
  else { console.log(`  FAIL ${m}${detail ? '\n         ' + detail : ''}`); fail++; }
};

/** Lakeside Jet Hangar Co INV26-00101, as Drive exports it. Layout quirks intact. */
const NAPLES = `NAPLES JET

CENTER

9 Runway Rd Lakeside, ST 00004 United States

Bill To: Example Aviation LLC

42 ELM ST

Springfield, ST 00001 United States

Telephone: 555-200-0020

Invoice

August 19, 2026

Invoice Number: INV26-00101

Account Code: ACED AVIATION LLC

Invoice Date: 08/19/2026

Payment Type: On Account

Payment Terms: Due On Receipt

INVOICE SUMMARY FOR WORK ORDER NUMBER: WO-4417

Registration Number: N200BB

Labor:

Parts:

Total:

1,242.50 USD

230.50 USD

1,473.00 USD

Shop Supplies

62.13 USD

Subtotal:

Total:

1,535.13 USD

1,535.13 USD

Full payment is due upon receipt.

Past due invoices will accrue interest at 1.5% per month.
`;

console.log('the invoice that named the feature');
{
  const f = fields(NAPLES);
  check('invoice number is read', f.invoiceNumber === 'INV26-00101', JSON.stringify(f.invoiceNumber));
  check('invoice date is transcribed to ISO', f.invoiceDate === '2026-08-19', JSON.stringify(f.invoiceDate));
  check('terms are reported verbatim', f.terms === 'due on receipt', JSON.stringify(f.terms));
  check('dueDate stays null — terms are the triage\'s to resolve', f.dueDate === null,
        `got ${JSON.stringify(f.dueDate)}; resolving "due on receipt" is judgement, not transcription`);
  check('the bill total wins over the line-item totals', f.total === 1535.13, String(f.total));
  check('and the ambiguity is on record', f.totalCandidates > 1, String(f.totalCandidates));
  check('it reads as an invoice', looksLikeInvoice(f) === true);

  const line = fieldsLine(f);
  check('the statements.md line carries number, amount and terms',
        line.includes('INV26-00101') && line.includes('$1,535.13') && line.includes('due on receipt'),
        line);
  check('and says when it was invoiced, since there is no due date',
        line.includes('invoiced 2026-08-19'), line);
}

console.log('\nan explicit due date IS transcribed — that part is not judgement');
{
  const f = fields('Invoice No: 4471\n' + 'x'.repeat(220) + '\nDue Date: 09/18/2026\nTotal: $2,400.00\n');
  check('dueDate is set', f.dueDate === '2026-09-18', JSON.stringify(f.dueDate));
  check('the line leads with the date, not the terms', fieldsLine(f).includes('due 2026-09-18'));
}

console.log('\nnet terms are surfaced, still not resolved');
{
  const f = fields('Invoice Date: 3/1/2026\nTerms: Net 30\n' + 'x'.repeat(220));
  check('terms normalise to "net 30"', f.terms === 'net 30', JSON.stringify(f.terms));
  check('dueDate stays null', f.dueDate === null, JSON.stringify(f.dueDate));
}

console.log('\nunreadable is not empty');
{
  // ARKO's cabinetry quote. This is genuinely all Drive returns for it.
  const f = fields('Page 1 of 2\n\nPage 2 of 2');
  check('an image-only PDF reports blind', f.blind?.includes('no text layer'), JSON.stringify(f));
  check('blind is not mistaken for an invoice', looksLikeInvoice(f) === false);
  check('and the line says so out loud', fieldsLine(f).includes('unread'), fieldsLine(f));
}

console.log('\nno labels, no fields — a letter is not a bill');
{
  const f = fields('Dear Alex,\n\nThank you for your business this year. '
                 + 'We look forward to seeing you again in 2026. Total commitment to service.\n'
                 + 'x'.repeat(220));
  check('no invoice number', f.invoiceNumber === null, JSON.stringify(f.invoiceNumber));
  check('no due date', f.dueDate === null);
  check('a bare "Total" with no figure yields no amount', f.total === null, String(f.total));
  check('it does not read as an invoice', looksLikeInvoice(f) === false);
  check('and it adds nothing to the record', fieldsLine(f) === '', JSON.stringify(fieldsLine(f)));
}

console.log('\ndates: a parse failure is null, never a guess');
{
  check('US order on slashes', isoDate('08/19/2026') === '2026-08-19');
  check('two-digit year is 20xx', isoDate('3/1/26') === '2026-03-01');
  check('ISO passes through', isoDate('2026-09-18') === '2026-09-18');
  check('long form', isoDate('August 19, 2026') === '2026-08-19');
  check('abbreviated month', isoDate('Sep. 3, 2026') === '2026-09-03');
  check('month 13 is not a date', isoDate('13/40/2026') === null);
  check('31 September is not a date', isoDate('09/31/2026') === null);
  check('a year out of range is not a date', isoDate('01/01/1899') === null);
  check('empty is null', isoDate('') === null);
  check('nonsense is null', isoDate('sometime next week') === null);
}

console.log('\namounts: labelled only, largest first');
{
  check('unlabelled figures are ignored',
        amounts('The aircraft has 1,242.50 hours on it.').length === 0);
  check('labelled figures are found, sorted',
        JSON.stringify(amounts('Total: 100.00\nAmount Due: 250.00')) === '[250,100]');
  check('a label with no figure near it finds nothing',
        amounts('Total commitment to your satisfaction.').length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
