/**
 * A scratch page for one question: does iOS offer code autofill from a message
 * Alex sent to himself?
 *
 * ## ANSWERED. No. Do not re-run this to find out.
 *
 * Tested 2026-08-30 and again 2026-09-01, the second time sending from Obligations.app
 * rather than Messages to rule out the sender: **QuickType offers nothing.** A
 * message from any device on his own Apple ID lands in the self-thread as
 * *sent*, and iOS only offers security-code autofill on a message it considers
 * *received*. Relay-via-the-Mac is dead regardless of what does the sending.
 *
 * What works is SMS from a number that is not his, in Apple's domain-bound form
 * — proven through voip.ms. `rules/realtime-push.md`, "How a code reaches him",
 * is the record; read it before proposing this experiment again.
 *
 * The page is kept because it is still the rig for testing *SMS* autofill
 * against a real domain, which is a live question. It is not evidence that the
 * iMessage question is open: this rig outliving its experiment is exactly what
 * caused the second run.
 *
 * That answer decides how login codes reach him under "Email 0". If autofill
 * works on a self-sent thread, the assistant can relay a code as an iMessage and
 * mail never touches his phone at all. If it does not, the notification can only
 * say a code arrived and he has to go and read it — which is most of what the
 * feature is trying to end. Worth five minutes before anything is built on the
 * assumption.
 *
 * Not in the nav on purpose. It is a test rig, not a page.
 *
 * The two things that make autofill actually fire, and are easy to get wrong:
 *
 *   - the input must be `autocomplete="one-time-code"` inside a real <form>,
 *     which is the marker iOS looks for. `inputmode="numeric"` gets the right
 *     keyboard but has nothing to do with autofill.
 *   - a **domain-bound** message (`@domain #code`) only offers on that exact
 *     domain. The domain below is hardcoded to this page's own host for that
 *     reason: pointing it at google.com and testing here would fail correctly
 *     and look like a broken feature.
 */
export const OTP_PAGE = `<!doctype html><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>obligations — otp autofill test</title>
<link rel=stylesheet href="/assets/style.css">
<div class=wrap>

<div class=top>
  <h1>one-time-code autofill</h1>
</div>

<p class=mut>Does iOS offer a code from a message you sent <em>yourself</em>?
Send one of the two below to your own number, then come back and tap the field.</p>

<h2>1 · the field</h2>
<div class=card>
  <form id=f autocomplete=on>
    <label class=otp-label for=otp>verification code</label>
    <input id=otp name=otp type=text inputmode=numeric autocomplete=one-time-code
           autocorrect=off autocapitalize=off spellcheck=false maxlength=8
           placeholder="000000">
  </form>
  <div id=saw class=otp-saw>nothing yet</div>
</div>

<h2>2 · send yourself one of these</h2>
<div class=card>
  <p class=mut>Heuristic form — should offer on any code field:</p>
  <pre class=code><code id=m1>Your verification code is 284913</code></pre>
  <button class=otp-copy data-for=m1 type=button>copy</button>

  <p class=mut style="margin-top:1.2rem">Domain-bound form — only offers on
  <code id=host>this domain</code>, which is why the domain is filled in for you:</p>
  <pre class=code><code id=m2>Your verification code is 284913

@example.com #284913</code></pre>
  <button class=otp-copy data-for=m2 type=button>copy</button>
</div>

<h2>3 · what it means</h2>
<div class=card>
  <p><strong>QuickType offers the code</strong> — autofill works from a self-sent
  thread. The assistant can relay codes as iMessage and mail never reaches the phone.</p>
  <p><strong>Nothing appears</strong> — try the other format first. If neither
  works, iOS only autofills from messages it considers received, and codes have
  to arrive as a push you read and type.</p>
  <p class=mut>The box above shows what actually landed in the field, so a value
  that appears without you typing is autofill and not muscle memory.</p>
</div>

</div>
<script type=module src="/assets/otp.js"></script>
`;
