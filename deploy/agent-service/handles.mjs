/**
 * An address that is a machine, not a person. Shared by the draft door (never
 * reply to one), the people graph (never list one as a person), and anything
 * else that has to tell "who" from "what".
 *
 * Deliberately tight. `info@` and `support@` are left alone: Hope at Sunrise
 * writes from info@, and a support address answers with a name. What is here
 * never carries a person on the other end.
 */
export const isMachine = (addr) => {
  const a = String(addr ?? '').toLowerCase();
  const local = a.includes('@') ? a.split('@')[0] : a;
  return /^(no-?reply|donotreply|do-not-reply|mailer-daemon|postmaster|bounces?|notifications?|alerts?|reminders?|newsletters?|marketing|billing|invoice(\+|s?$)|receipts?)(\b|[-+.])/.test(local)
    || /\b(reminder|no-?reply|donotreply|mailer-daemon|notifications?|postmaster|bounces?)@/.test(a)
    || /@superhuman\.com$/.test(a)
    // A helpdesk queue: the thread's last sender at ICON was
    // support@…zohodesk.com, and the draft went to the queue instead of the
    // person whose name it opened with (evening job, 2026-09-06).
    || /@[a-z0-9.-]*\.(zohodesk|zendesk|freshdesk|helpscout|desk365|servicedesk)\.com$/.test(a) || /^(support|helpdesk|tickets?|desk)@[a-z0-9.-]*desk[a-z0-9.-]*$/.test(a);
};

/**
 * Person, organisation or machine — the one place that answers "is this a
 * person", for the People page.
 *
 * Alex, 2026-09-22: "https://obligations.example.com/people needs a complete
 * rethink. Lets make it people only to begin with, it has a lot of
 * organizations in there." It had: of 951 distinct senders a third were role
 * mailboxes, and `isMachine` above is deliberately tight — it leaves `info@`
 * and `support@` alone, because a draft to Hope at Sunrise must still go to
 * info@. That is right for the draft door and wrong for a list of people: a
 * mailbox a person answers is still a mailbox, not a person. So this is a
 * separate, wider test, and it never decides where mail may go.
 *
 * `name` is the best display name known (a contact card, the mail's own From
 * name). `trusted` means the name came from somewhere that names people — a
 * people/ file or his address book — and then only an unmistakable company word
 * in it makes it an organisation. A wrong exclusion hides a real person, so the
 * word lists hold what almost never ends a person's name: Church, Hall, Banks
 * and the like are left out on purpose.
 */
const ROLE_LOCAL = /^(myaccount|info|infos|sales|team|hello|hi|hey|support|help|helpdesk|admin|administrator|office|orders?|accounts?|accounts\.receivable|accountsreceivable|accounts\.payable|accountspayable|ar|ap|payments?|contact|contactus|service|services|customerservice|customer\.service|customercare|care|reservations?|bookings?|events?|membership|members|press|media|pr|hr|careers|jobs|recruiting|enquiries|inquiries|general|frontdesk|front\.desk|reception|security|receiving|shipping|manager|management|concierge|leasing|operations|ops|dispatch|scheduling|appointments?|webmaster|feedback|community|partners?|partnerships|newsletter|news|updates?|hola|ahoy|mail|email|inbox|studio|shop|store|orders|returns|warranty|legal|compliance|privacy|finance|accounting|bookkeeping|tax|claims|underwriting|servicing|loans?|mortgage|escrow|closing|title)$/;

const STRONG_ORG = /\b(relations|renewals|rewards|ventures|online|billing|paperless|account|accounts|energy|club|program|programme|perks|portfolios|research|developer|developers|coordinator|enforcement|journal|insider|business|storage|destinations|experience|concierge|dispatch|operations|inc|llc|l\.l\.c|ltd|limited|corp|corporation|plc|gmbh|bank|insurance|airlines?|airways|association|foundation|realty|clinic|dental|hotel|hotels|residences|resort|holdings|university|hospital|pharmacy|restaurant|condominium|condominiums|hoa|services|support|team|group|solutions|technologies|systems|partners|capital|properties|management|motors|aviation|academy|institute|society|federal credit union|credit union|customer care|front desk|reservations)\b/i;

/* Mail services people use for themselves. At one of these an address with
   no role in its local part is a person — a company does not run its billing
   out of gmail. Anywhere else the name has to earn it (below). */
const CONSUMER = /@(gmail|googlemail|icloud|me|mac|yahoo|ymail|rocketmail|hotmail|outlook|live|msn|aol|comcast|verizon|att|sbcglobal|bellsouth|cox|charter|earthlink|protonmail|proton|pm|fastmail|gmx|hey|rr)\./;

/** "First Last" or "First M. Last": two to four capitalised words and nothing
 *  a brand wears — no colon, ampersand, digit, or camelCase ("GoDaddy",
 *  "QuickBooks", "GasCo"), with the usual surname prefixes let through. */
export function looksLikePersonName(name) {
  const words = String(name ?? '').replace(/\s+/g, ' ').trim().split(' ');
  if (words.length < 2 || words.length > 4) return false;
  return words.every((w) => /^[A-Z]\.?$/.test(w)
    || (/^[A-Z][A-Za-z'’-]+$/.test(w) && (!/^[A-Z][a-z]+[A-Z]/.test(w) || /^(Mc|Mac|O'|O’|D'|D’|De|Di|La|Le|Van|Von)[A-Z]/.test(w))));
}

/** Does the address carry the name — a first or last name, or initials? */
export function localCarriesName(local, name) {
  const l = String(local ?? '').toLowerCase().replace(/[^a-z]/g, '');
  const w = String(name ?? '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  if (!l || w.length < 2) return false;
  const first = w[0], last = w[w.length - 1];
  /* The first four letters of the first name, not the whole of it: people
     write from a short form. Nina Cole is ninac@, Matthias Hartman is
     matt@, Natalia Salis is natalie@ — all three were hidden as companies on
     the first pass of 2026-09-22, and Nina was a live vendor thread. */
  const stem = first.length >= 4 ? first.slice(0, 4) : first;
  /* Short and initial forms, all real people hidden on the second pass:
     RJ Gaines is rj@, Erin Booth is e@, Madison Rae Mercer is
     mm16bm@. A brand's mailbox is rarely its sender's initials. */
  if (l === first || l === first[0] || l.startsWith(first[0] + last[0])) return true;
  return (stem.length >= 3 && l.includes(stem)) || (last.length >= 3 && l.includes(last))
    || l === first[0] + last[0] || l.startsWith(first[0] + last) || l.startsWith(first + last[0]);
}

export function kindOf(handle, { name = '', trusted = false, isCompany = false } = {}) {
  if (isCompany) return 'organisation';
  const h = String(handle ?? '').trim().toLowerCase();
  const n = String(name ?? '').trim();
  if (trusted) return n && STRONG_ORG.test(n) ? 'organisation' : 'person';
  if (h && isMachine(h)) return 'machine';
  if (h.includes('@')) {
    const local = h.split('@')[0].replace(/\+.*$/, '');
    if (ROLE_LOCAL.test(local)) return 'organisation';
  } else if (h && !/^\+?\d[\d\s().-]{6,}$/.test(h)) {
    // No address and not a phone: the triage wrote a label, not a handle.
    // A slug or a single word ("frontier-airlines", "SiriusXM") is a brand;
    // a person the triage named has a first and a last name.
    if (/[-_]/.test(h) || !/\s/.test(h)) return 'organisation';
    // ...written like a name, when the case survives to here ("state farm" is
    // a label; "Pete Rourke" is a person). A label with no capital at all says
    // nothing either way, so only a capitalised one is judged on its shape.
    const label = n || String(handle ?? '').trim();
    if (/[A-Z]/.test(label) && !looksLikePersonName(label)) return 'organisation';
    if (!/[A-Z]/.test(label)) return 'organisation';
  }
  if (n && STRONG_ORG.test(n)) return 'organisation';
  if (h.includes('@')) {
    /* A NAMED PERSON AT A COMPANY, or the company. The first live run left
       "GoDaddy Renewals", "QuickBooks Online", "Investor Relations" and a
       nameless store3248@shipstore.example in the list: role words cannot
       enumerate every department, but a person's mail has a person's name
       on it, and their address usually carries it. */
    if (CONSUMER.test(h)) return 'person';
    const [local, domain] = h.split('@');
    const named = n && n.toLowerCase() !== h;
    /* The name's first word in the sending domain is a brand signing its own
       mail: Pizza Hut from pizzahut.com, American Express from
       americanexpress.com, Clear Water from co55d5.example. A person's FIRST
       name is almost never in their employer's domain — Alex Lawson's surname
       is in co997d.example, which is why only the first word counts. */
    /* A label of the domain STARTS with the word — "eli" inside
       "raelistudio" is not Eli's brand. And a plain personal address wins even
       then: Joanna Dalton writes as julie@cob675.example, her own firm. */
    const firstWord = n.toLowerCase().split(/\s+/)[0]?.replace(/[^a-z]/g, '') ?? '';
    const words = n.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
    const lastWord = words[words.length - 1] ?? '';
    const personal = [firstWord, `${firstWord}.${lastWord}`, `${firstWord}_${lastWord}`, `${firstWord}-${lastWord}`, `${firstWord[0]}${lastWord}`]
      .includes(String(local).toLowerCase());
    const brand = !personal && firstWord.length >= 3
      && String(domain ?? '').split('.').some((lab) => lab.replace(/[^a-z]/g, '').startsWith(firstWord));
    return named && !brand && looksLikePersonName(n) && localCarriesName(local, n) ? 'person' : 'organisation';
  }
  return 'person';
}
