/**
 * The otp-test page.
 *
 * Two jobs: fill this page's own host into the domain-bound example, and report
 * what actually landed in the field. The second one matters — an empty box and
 * a box you typed into look identical afterwards, and the whole question is
 * whether the value arrived without you.
 */
const field = document.getElementById('otp');
if (field) {
  const saw = document.getElementById('saw');

  // A domain-bound message only offers on the matching domain, so the example
  // has to name THIS page's host. Hardcoding google.com here would fail
  // correctly and read as a broken feature.
  const host = location.hostname;
  document.getElementById('host').textContent = host;
  const m2 = document.getElementById('m2');
  m2.textContent = m2.textContent.replace('@example.com', '@' + host);

  let typed = false;
  field.addEventListener('keydown', () => { typed = true; });

  const report = () => {
    const v = field.value.trim();
    if (!v) { saw.textContent = 'nothing yet'; saw.className = 'otp-saw'; return; }
    saw.textContent = typed
      ? `${v} — typed by hand`
      : `${v} — filled without a keystroke, which is autofill`;
    saw.className = 'otp-saw ' + (typed ? 'typed' : 'filled');
  };
  field.addEventListener('input', report);
  // Autofill does not always raise `input` on every platform, so poll as well.
  setInterval(report, 400);

  for (const b of document.querySelectorAll('.otp-copy')) {
    b.onclick = async () => {
      const text = document.getElementById(b.dataset.for).textContent;
      try {
        await navigator.clipboard.writeText(text);
        b.textContent = 'copied';
      } catch {
        // Clipboard needs a secure context and a user gesture; both hold here,
        // but a refusal must not look like the page is broken.
        b.textContent = 'select it by hand';
      }
      setTimeout(() => { b.textContent = 'copy'; }, 1500);
    };
  }
}
