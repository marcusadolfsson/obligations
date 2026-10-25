/**
 * kindOf — person, organisation or machine, for the People page.
 *
 * Alex, 2026-09-22: "Lets make it people only to begin with, it has a lot of
 * organizations in there." Every case below is a real row from that day's
 * live list, on one side of the line or the other. A wrong exclusion hides a
 * real person, which is worse than a brand slipping through, so most of these
 * are the people who must stay.
 */
import { kindOf, looksLikePersonName, localCarriesName, isMachine } from './handles.mjs';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  ok   ${m}`); };
const bad = (m, d) => { fail++; console.log(`  FAIL ${m}${d ? ' -> ' + d : ''}`); };
const check = (m, c, d) => (c ? ok(m) : bad(m, d));
const is = (want, handle, name, opts = {}) => {
  const got = kindOf(handle, { name, ...opts });
  check(`${name || handle} is ${want === 'person' ? 'a person' : `an ${want}`}`, got === want, `${handle} -> ${got}`);
};

console.log('people who must stay');
is('person', 'alex@druckerlawson.example', 'Alex Lawson');            // surname in the domain, not the first name
is('person', 'hart.sharon@oliverco.example', 'Sharon Hart');
is('person', 'ninac@citycab.example', 'Nina Cole');         // a short form of the first name
is('person', 'matt@summitpeak.example', 'Matthias Hartman');
is('person', 'natalie@crestlinecabinets.example', 'Natalia Salis');
is('person', 'rj@co6ddc.example', 'RJ Gaines');                    // two-letter first name
is('person', 'e@co90e8.example', 'Erin Booth');              // a single initial
is('person', 'mm16bm@med.stateu.edu', 'Madison Rae Mercer');       // initials and digits
is('person', 'eli@raelistudio.example', 'Eli Novak');           // "eli" inside "raelistudio" is not a brand
is('person', 'joanna@joannadaltonlaw.example', 'Joanna Dalton');          // her own firm
is('person', 'ef@globaljets.example', 'Elliot  Forster');           // double space, initials
is('person', '2kssimon@gmail.com', 'Simon Moss');                 // consumer mail
is('person', 'bjones25@gmail.com', '');                            // consumer mail, no name at all
is('person', '+17275551234', '');                                  // a phone is someone texting
is('person', 'Pete Rourke', 'Pete Rourke');                            // a name the triage wrote

console.log('\norganisations that must go');
is('organisation', 'info@co55d5.example', 'Clear Water');            // role mailbox
is('organisation', 'accounts.receivable@northwind-aero.example.br', 'Accounts Receivable');
is('organisation', 'myaccount@northwind-aero.example', 'My Account');
is('organisation', 'renewals@e.godaddy.com', 'GoDaddy Renewals');  // camelCase brand
is('organisation', 'bankconnections@quickbooks.intuit.com', 'QuickBooks Online');
is('organisation', 'investorrelations@co4f24.example', 'Investor Relations');
is('organisation', 'hutrewards@mail.pizzahut.com', 'Pizza Hut');   // the brand in its own domain
is('organisation', 'americanexpress@welcome.americanexpress.com', 'American Express');
is('organisation', 'vorysenforcement@co47f7.example', 'Legal Enforcement');
is('organisation', 'store3248@shipstore.example', '');               // a company mailbox with no name
is('organisation', 'powercopaperlessbilling@paperless.power-co.example', 'Power Co Paperless Billing');
is('organisation', 'riverton@carta.example', 'Carta: Riverton Ventures');
is('organisation', 'frontier-airlines', '');                       // a slug the triage wrote
is('organisation', 'state farm', 'state farm');                    // a lower-case label
is('machine', 'noreply@github.com', '');

console.log('\ntrusted names — a people/ file or a contact card');
check('a contact card with a person\'s name is a person, whatever its address',
      kindOf('info@sunrise-nannies.example', { name: 'Hope Hayes', trusted: true }) === 'person');
check('  a card whose name is unmistakably a company is not',
      kindOf(null, { name: 'Avionics Co Support', trusted: true }) === 'organisation');
check('  and the Mac\'s company flag wins over any name',
      kindOf(null, { name: 'Crestline', trusted: true, isCompany: true }) === 'organisation');

console.log('\nthe two helpers');
check('"First Last" is a name', looksLikePersonName('Sharon Hart'));
check('  "First M. Last" is a name', looksLikePersonName('Simon R Forehand') && looksLikePersonName('Paul W. Swain'));
check('  a surname prefix is not camelCase', looksLikePersonName('Kathy MacLeod'));
check('  camelCase is a brand', !looksLikePersonName('GoDaddy Renewals'));
check('  one word is not a name', !looksLikePersonName('GasCo'));
check('  a colon or ampersand is not a name', !looksLikePersonName('Carta: Riverton') && !looksLikePersonName('P&EC Power'));
check('an address carries a surname', localCarriesName('carmichael.margie', 'Marge Carlton'));
check('  or neither name at all', !localCarriesName('bankconnections', 'QuickBooks Online'));
check('isMachine is unchanged by any of this — info@ still reaches Hope',
      !isMachine('info@sunrise-nannies.example'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
