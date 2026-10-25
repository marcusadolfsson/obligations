/**
 * The lane a task is done in (lanes.mjs).
 *
 * Alex, 2026-10-03: "I need more help to tackle similar to dos in one
 * sitting." Every title below is a real one from his open list that day, and
 * the cases that matter most are the ones that would put a task in the wrong
 * sitting: a reply read as admin because it starts "Get back to", a bill read
 * as a reply, something he is owed given a lane at all.
 */
import { laneOf, leadingVerb, LANES, LANE_LABEL } from './lanes.mjs';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  ok   ${m}`); };
const bad = (m, d) => { fail++; console.log(`  FAIL ${m}${d ? ' -> ' + d : ''}`); };
const lane = (title, extra = {}) => laneOf({ title, owed_by: 'me', tags: [], ...extra });
const is = (title, want, extra) => {
  const got = lane(title, extra);
  if (got === want) ok(`"${title}" → ${want}`); else bad(`"${title}" → ${want}`, got);
};

console.log('Replies:');
is('Tell Carl where you stand on the Brava round', 'reply');
is('RSVP to Paul Grant\'s Bayview reception', 'reply');
is('Send Ari feedback on the Studio rendering and estimate', 'reply');
is('Say if you\'re joining Monday\'s Kestrel Kerr meeting', 'reply');
is('Get back to Neil Fairley', 'reply');           // "get" alone is admin; "get back to" is a reply
is('Come back to Goldwing Aviation on the N200BB structure', 'reply');
is('Circle back to Jared on OPOA membership structure, then the rest', 'reply');

console.log('\nDecisions:');
is('Decide on Simon Kerr\'s Oak Ave financing ask', 'decide');
is('Review Nate\'s 15yr inspection quote', 'decide');
is('Elect on the Wetherby Capital Bayfront Academy sale', 'decide');
is('Pick villa dates and reply to Go Charity', 'decide');
is('Boat 15yo engine decision!', 'decide');            // by its own word
is('Cabinetry vendor for ONE 2201/2202', 'decide', { tags: ['decision'] });

console.log('\nBills:');
is('Pay the Webber invoice INV-00001001', 'pay');
is('Review the new PEC ESP invoice (5552000010)', 'pay', { tags: ['invoice'] });  // the kind tag outranks the verb

console.log('\nCalls and scheduling:');
is('Schedule the N200BB 60-month inspection', 'call');
is('Book the N200BB maintenance off the due list', 'call');
is('Set up a call with the Brava founders', 'call');
is('Set the gym time for Thursday', 'call');          // a time is an appointment

console.log('\nAdmin:');
is('Get the ELCO tax document off the fund portal', 'admin');
is('Pull the ELCO tax document off the fund portal', 'admin');
is('Update the card on TruGreen EasyPay', 'admin');
is('Reset the CAA platform password', 'admin');
is('Pick up Noah from school', 'admin');            // "pick up" fetches; "pick" alone decides
is('Pick up the RFID boards from the vendor', 'admin');
is('Set up the new Amex card in QuickBooks', 'admin'); // "set" with no call, meeting or time in it

console.log('\nWhat it will not guess:');
is('Aircraft hours: Northwind — N200BB, N300CC (2026-09)', 'other');
is('QBO Catchup - Acme Inv, Acme, PP, Springfield Aviators, Personal', 'other');
is('Spending Review, budget', 'other');
{
  const theirs = laneOf({ title: 'Tell us the closing date', owed_by: 'them', tags: [] });
  if (theirs === null) ok('something they owe him has no lane — it is waiting, not work');
  else bad('something they owe him has no lane', theirs);
  const untitled = laneOf({ what: 'renew the hangar insurance before the policy lapses', owed_by: 'me' });
  if (untitled === 'admin') ok('a todo line with only `what` is read by its words'); else bad('an untitled item is read by what', untitled);
  const blank = laneOf({});
  if (blank === 'other') ok('an empty item is other, not a crash'); else bad('an empty item is other', blank);
}

console.log('\nThe shape:');
if (leadingVerb('  "Tell Carl"') === 'tell') ok('the leading verb skips quotes and space'); else bad('leading verb', leadingVerb('  "Tell Carl"'));
if (LANES.every((l) => LANE_LABEL[l])) ok('every lane has a label for the page'); else bad('a lane has no label');
if (LANES.at(-1) === 'other') ok('other is the last lane, so the page lists it last'); else bad('other is not last');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
