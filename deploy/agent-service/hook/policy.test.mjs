/**
 * The subject patterns, against subjects Alex has actually been sent.
 *
 * Alex, 2026-09-08: "why is the gmail push two factor emails to sms not
 * firing?" — then, "recent ones came from Northwind". The pipeline was healthy:
 * the watch was armed, 3,140 Pub/Sub notifications had arrived, 1,367 messages
 * had been examined and six had rung the phone. What was wrong was one word.
 * The alternation read verification, security, login, sign-in, one-time and
 * access — and FlyNorthwind sends "FlyNorthwind - Authentication Code", so every
 * code from the portal he uses for his own aircraft was refused as "subject
 * matched no ratified pattern".
 *
 * There was no test on the patterns at all, and there could not easily be one,
 * because subjects are deliberately never written to disk — a refused code and
 * a refused newsletter are indistinguishable in the log. So the guard has to be
 * this: a list of real subjects, in the repo, checked against the LIVE policy
 * file. It is the same argument as contract.mjs — a fixture that invents its
 * own format proves nothing about the file everything else reads.
 *
 * Adding a subject here is cheap. Every one of them is a code that did not
 * arrive, or an ordinary mail that must never ring at 03:00.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPolicy } from './policy.mjs';

const OBLIGATIONS = process.env.OBLIGATIONS ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

let pass = 0, fail = 0;
const check = (what, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? ` -> ${detail}` : ''}`); }
};

const policy = await loadPolicy(OBLIGATIONS);
const matches = (subject) => policy.patterns.some((re) => re.test(subject));

console.log('The live policy parses');
check('no problems reported', policy.ok && policy.problems.length === 0, JSON.stringify(policy.problems));
check('there are patterns at all — with none, nothing can ever ring',
      policy.patterns.length > 0, String(policy.patterns.length));
check('at least one of his own addresses is listed',
      policy.addresses.length > 0, JSON.stringify(policy.addresses));

/* Codes he has actually been sent. A miss here is a login he cannot complete
 * from his phone. */
console.log('\nMust ring — real codes');
for (const s of [
  'FlyNorthwind - Authentication Code',       // the one that was missed, 2026-09-08
  'FlyNorthwind authentication code',         // same service, lower case, no dash
  'Your ForeFlight Verification Code',      // delivered by SMS 2026-09-02
  'Your login code',
  'Your one-time code for signing in',
  'Din engångskod är här',                  // Swedish: he is on .se services
  'Verify your email address',
  'Sign-in link for your account',
]) check(s, matches(s));

/* Ordinary mail from the same senders. A false positive here is a stranger,
 * or a robot, ringing his phone in the middle of the night — which is the
 * capability this whole file exists to bound. */
console.log('\nMust stay silent — ordinary mail');
for (const s of [
  'FlyNorthwind - Password Updated',
  'FlyNorthwind password expiry',
  'Northwind interest fee invoice, ACED Aviation',
  'Northwind weekly accounts-receivable report, Example Aviation',
  'Northwind technical-publications subscription expired',
  'FlightAware Sign In Notification',       // a notice that someone signed in
  'Login for N300CC stopped working',        // a human describing a problem
  'July hours for N200BB and N300CC',
  'Your weekly digest',
  'Receipt for your order',
]) check(s, !matches(s), 'this would ring his phone');

/* The caps exist so a runaway edit fails closed rather than turning the phone
 * into a siren. */
console.log('\nThe caps still bound it');
check('under the pattern cap', policy.patterns.length <= 20, String(policy.patterns.length));
check('under the sender cap', Object.keys(policy.senders).length <= 30);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
