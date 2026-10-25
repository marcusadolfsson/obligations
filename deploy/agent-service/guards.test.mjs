/**
 * Three structural guards. Each exists because of a specific failure, and each
 * would have turned that failure from a silent outage into a red test.
 *
 *   WIRING       a job told to run a script that is not allowed to run; a page
 *                loading an asset the server does not serve; a nav link to
 *                nothing. Five hand-maintained lists that must agree.
 *   WALL CLOCK   a local timestamp with no offset, compared across process
 *                boundaries. Broke three separate things in one day.
 *   TEST VALIDITY  a suite whose assertions never execute, or which asserts
 *                nothing at all. Both shipped today.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* The repo root. OBLIGATIONS wins where it is set — the container sets it — but the
   fallback is derived from this file's own location rather than the container's
   mount point. It used to default to the literal '/obligations', so running this on
   the host died with a raw ENOENT stack for a path that exists nowhere on that
   machine. A guard people cannot run outside the container is a guard people
   stop running. This file sits at <repo>/deploy/agent-service/, so ../.. is the
   root in both places. */
const OBLIGATIONS = process.env.OBLIGATIONS ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..');
let pass = 0, fail = 0;
const ok = (m) => { console.log(`  ok   ${m}`); pass++; };
const bad = (m, d) => { console.log(`  FAIL ${m}${d ? ' -> ' + d : ''}`); fail++; };
const read = (rel) => readFile(join(OBLIGATIONS, rel), 'utf8');

/* ============================================================ 1. WIRING === */

console.log('Wiring: the lists that must agree');
{
  const settings = JSON.parse(await read('.claude/settings.json'));
  const allow = settings.permissions?.allow ?? [];

  /* The chat may be wider than a job — but only in the ways that were chosen.
   *
   * Alex, 2026-09-04: "I want the chat to be as capable as a Claude chat."
   * That moved some denies out of .claude/settings.json (shared by both callers)
   * into JOB_ONLY_DENY in server.mjs, applied to the job path alone, so the chat
   * reaches those tools through the approval prompt instead of never seeing them.
   *
   * The inversion is the risk. The shared file used to be what stopped these, so
   * every caller was closed by default; now a caller that forgets
   * `disallowedTools` is open. Two things are checked here, and the second is
   * the one that matters:
   *
   *   1. Nothing is in both lists. A name in both is not dangerous, it is
   *      confusing — it reads as job-only while actually being denied to
   *      everyone, and the next person to widen the chat would remove the wrong
   *      line and believe they had changed something.
   *   2. The hard limits are STILL in the shared deny. These are not
   *      unattended-safety rules that a human in the loop makes unnecessary —
   *      they are Alex's own limits from CLAUDE.md, and they bind the chat
   *      exactly as much as a job. Widening the chat is a decision; widening it
   *      into these would be an accident, and this is what makes that accident
   *      fail loudly instead of shipping.
   */
  {
    const settings = JSON.parse(await read('.claude/settings.json'));
    const deny = new Set(settings.permissions?.deny ?? []);
    const srv = await read('deploy/agent-service/server.mjs');

    const block = srv.match(/const JOB_ONLY_DENY = \[([\s\S]*?)\];/);
    const jobOnly = block ? [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];

    if (!block) {
      bad('JOB_ONLY_DENY is gone from server.mjs — the chat/job split is not where this guard thinks');
    } else if (!srv.includes('disallowedTools: JOB_ONLY_DENY')) {
      bad('JOB_ONLY_DENY exists but the job path does not pass it',
          'the jobs would silently get every tool that was moved out of the shared deny');
    } else {
      const both = jobOnly.filter((t) => deny.has(t));
      if (both.length) {
        // Half-done is the expected state between the two edits, and it is a
        // failure rather than a warning on purpose: the job-side protection
        // must land BEFORE the chat-side widening, and this is what stops the
        // pair being left incomplete in either direction.
        bad('the chat/job split is half applied',
            `still in .claude/settings.json "deny": ${both.join(', ')}. `
            + 'The job path already refuses these, so deleting those lines widens '
            + 'the chat only. Until then they are denied to everyone and the chat '
            + 'is no wider than before.');
      } else {
        ok(`${jobOnly.length} tools are denied to jobs and offered to the chat behind approval`);
      }
    }

    /* Never widen. Each of these is a sentence in CLAUDE.md, not a precaution
     * about running unattended. If one needs to go, it is Alex's call and the
     * rule it comes from has to change with it. */
    const HARD = [
      ['Bash(rm:*)', 'never rm a file in people/ or projects/'],
      // Rewriting what the remote already has, not publishing to it. The
      // blanket `Bash(git push:*)` used to sit here under the same reason, and
      // the reason only ever fitted these: a plain push adds commits, it does
      // not destroy the undo button. Alex, 2026-09-08 — see the push block
      // below for what replaced it and why.
      ['Bash(git push --force:*)', "his undo button is git history"],
      ['Bash(git push -f:*)', "his undo button is git history"],
      ['Bash(git push --mirror:*)', 'replaces every remote ref with a local one'],
      ['Bash(git push --delete:*)', 'removes a ref from the remote'],
      ['Bash(git reset:*)', "his undo button is git history"],
      ['Bash(git -C:*)', 'the -C form escapes both halves of the permission policy'],
      ['Bash(curl:*)', 'the exfiltration verb; WebFetch is the supervised alternative'],
      ['mcp__personal__delete_email', 'never delete email; archive is the strongest verb'],
      ['mcp__personal__move_to_spam', 'never delete email'],
      ['mcp__personal__create_filter', 'never create standing rules'],
      ['mcp__personal__pair_recipient', 'the agent must never widen its own reach'],
      ['mcp__claude_ai_Google_Drive__share_file', 'sharing his documents acts outward as him'],
    ];
    // curl is denied in the container's own settings, not the repo's — see the
    // comment in deploy/claude-home/settings.json for why it lives there.
    let containerDeny = [];
    try {
      containerDeny = JSON.parse(await read('deploy/claude-home/settings.json'))
        .permissions?.deny ?? [];
    } catch { /* gitignored and may be absent on a fresh checkout */ }
    const everywhere = new Set([...deny, ...containerDeny]);

    // Without the container settings on disk, the rule that lives only there cannot be checked here.
    const containerOnly = containerDeny.length ? [] : ['Bash(curl:*)'];
    const dropped = HARD.filter(([rule]) => !everywhere.has(rule) && !containerOnly.includes(rule));
    if (dropped.length) {
      bad('a hard limit is no longer denied',
          dropped.map(([r, why]) => `${r} (${why})`).join('; '));
    } else {
      ok(`all ${HARD.length} pinned hard limits are still denied to everyone`);
    }

    /* Pushing must stay in the THIRD state: in neither list.
     *
     * Alex, 2026-09-08, when the agent developing the native iMessage app on
     * the Mac mini could not deliver its own code. `Bash(git push:*)` had been
     * a blanket deny under the reason "his undo button is git history", which
     * is true of --force and not of publishing a commit — and it never bound
     * the thing it was written for. An unattended job is refused by canUseTool
     * in server.mjs, which denies anything not on the allow list and has
     * nobody to ask; 272 refusals in the log, every one tagged `job`. So the
     * deny only ever stopped attended sessions, which is backwards.
     *
     * Removing it was right. Putting a push rule in `allow` would NOT be: this
     * file's own header defines allow as "runs unattended, with nobody looking
     * at it", so it would hand the 07:00 job the push the deny was meant to
     * stop. That distinction is one line of JSON and easy to lose later, which
     * is the whole reason it is pinned here rather than only written down.
     */
    /* Routes a person must be behind. rules/capabilities.md, 2026-09-08.
     *
     * The Access gate refuses an unauthenticated request before any route
     * runs, so these checks are the second layer — and the second layer is
     * what stops the rule depending on one environment variable being set.
     * They also keep the audit honest: an outbox record reading
     * `approved_at: … by web` is a decision nobody can be held to.
     *
     * Adding a route that sends as him, approves something, widens what may
     * run unasked, or edits one of his standing files means adding it here.
     * The point of the list is that forgetting fails loudly. */
    const HIS_TAP = [
      ['/api/reply', 'queues a text the Mac sends within a minute, as him'],
      ['/api/outbox/status', 'sets approved, which is what makes the Mac send it'],
      ['/api/outbox/mail/send', 'sends mail as him'],
      ['/api/outbox/invite/send', 'mails an invitation to a third party in his name'],
      ['/api/approve', 'approves a tool call the agent asked for'],
      ['/api/auto-approve', 'widens what runs without asking again'],
      ['/api/reading/ignore', 'a standing silence — CLAUDE.md: his file, never the agent\'s'],
      ['/api/reading/sender', 'a standing rule about what is always reading'],
      ['/api/priorities', 'the focus lines are his and never the agent\'s to write'],
      ['/api/projects', 'the agent proposes project files and never creates them itself'],
      ['/api/todo', 'todo.md is his list; the agent adds to it through its own door, not this one'],
    ];
    const src = await read('deploy/agent-service/server.mjs');
    const ungated = HIS_TAP.filter(([route]) => {
      // The WRITE, specifically. Several of these have a GET beside them that
      // reads the same thing and needs no gate — looking for the path alone
      // finds the reader and reports the writer as unguarded.
      const at = src.indexOf(`req.method === 'POST' && url.pathname === '${route}'`);
      if (at === -1) return true;                       // gone is also a failure
      // The guard must be the first thing the route does, before it reads a
      // body or touches a file.
      return !/mustBeHim|!who\?\.email/.test(src.slice(at, at + 400));
    });
    if (ungated.length) {
      bad('a route that acts as him does not require his identity',
          ungated.map(([r, why]) => `${r} (${why})`).join('; '));
    } else {
      ok(`all ${HIS_TAP.length} routes that act as him refuse without his identity`);
    }

    // Silencing a sender is ASKS IN CHAT. Alex, 2026-09-15: "I need the chat
    // to actually be helpful!", after it refused to ignore SkyAngel for the
    // second time. On the allow list it would run unattended, and a job's input
    // is the very mail that might ask it to silence his bank.
    if (allow.some((r) => /ignore-sender\.mjs/.test(r))) {
      bad('ignore-sender.mjs is on the allow list, so a scheduled job could silence any sender',
          'it belongs in neither list: the chat asks, a job is refused');
    } else {
      ok('ignoring a sender stays in neither list: the chat asks, a job is refused');
    }

    const pushAllowed = allow.filter((r) => /^Bash\(git push\b/.test(r));
    if (pushAllowed.length) {
      bad('a git push rule is on the allow list, which means unattended jobs can push',
          `${pushAllowed.join(', ')} — push belongs in neither list, so chat asks and a job is refused`);
    } else {
      ok('git push is in neither list: an attended session asks, a scheduled job is refused');
    }
  }

  /* A function that is called but defined nowhere.
   *
   * `readable()` was deleted from web/chat.js on 2026-08-29 in a restyle commit
   * while its only call site stayed. It sits in the `approval` branch, so every
   * turn that needed a tool approved threw a ReferenceError, killed the SSE
   * reader and showed "Lost the connection to the agent". That went unnoticed
   * for six days, and it is the branch CLAUDE.md leans on for the whole
   * email-sending gate: "in chat, the permission prompt shows him the recipient
   * — that prompt IS the approval." The prompt was dead.
   *
   * pages.test.mjs could not catch it: it executes each file top to bottom
   * against a stub DOM, and a name inside a branch that never runs is a
   * runtime error, not a parse error. This looks for it statically instead.
   *
   * Strings and comments are stripped first — CSS in a template literal
   * (`translateX(...)`) otherwise reads as a call.
   *
   * **The stripping is a heuristic and it has two known traps**, both of which
   * have cost a session each. Only line comments that START a line are
   * removed, because a `//` inside a string is otherwise eaten; so an
   * apostrophe in a TRAILING `// the server's tally` comment opens a string
   * literal that runs to the next apostrophe in the file and swallows every
   * definition in between (2026-09-19). The same shape bit with `/*` written
   * inside a `//` comment (2026-09-18). When this reports a list of functions
   * that plainly do exist, suspect the stripper, not the code — the failure
   * below says so.
   */
  {
    const KEYWORD = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof',
      'function', 'new', 'await', 'async', 'do', 'else', 'delete', 'void', 'in', 'of',
      'instanceof', 'yield', 'throw', 'case', 'with', 'super', 'import', 'export', 'constructor']);
    /* Browser and language globals. Anything genuinely new the pages start
     * using has to be added here, which is the point: the list is small, and an
     * unrecognised bare call is far more often a deleted function than a global
     * nobody thought of. */
    const GLOBAL = new Set(['fetch', 'setTimeout', 'setInterval', 'clearInterval', 'clearTimeout',
      'requestAnimationFrame', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Date',
      'Math', 'Set', 'Map', 'Promise', 'Error', 'RegExp', 'encodeURIComponent', 'decodeURIComponent',
      'parseInt', 'parseFloat', 'isNaN', 'alert', 'confirm', 'prompt', 'console', 'document', 'window',
      'navigator', 'localStorage', 'EventSource', 'FormData', 'Blob', 'URL', 'URLSearchParams',
      'TextDecoder', 'ResizeObserver', 'MutationObserver', 'IntersectionObserver', 'AbortController',
      'structuredClone', 'queueMicrotask', 'Intl', 'Symbol', 'WeakMap', 'Proxy', 'Reflect', 'BigInt',
      'Response', 'Request', 'Headers', 'File', 'FileReader', 'Image', 'Audio', 'getComputedStyle',
      'matchMedia', 'SpeechRecognition', 'webkitSpeechRecognition', 'MediaRecorder', 'AudioContext',
      'Element', 'Node', 'HTMLElement', 'CustomEvent', 'Event', 'DOMParser', 'btoa', 'atob',
      'crypto', 'performance', 'history', 'location', 'scrollTo']);

    const undefined_ = [];
    let scanned = 0;
    for (const f of (await readdir(join(OBLIGATIONS, 'deploy/agent-service/web'))).filter((n) => n.endsWith('.js'))) {
      scanned++;
      const code = (await read(`deploy/agent-service/web/${f}`))
        .replace(/\/\*[\s\S]*?\*\//g, ' ')            // block comments
        .replace(/^\s*\/\/.*$/gm, ' ')                 // line comments
        .replace(/`(?:[^`\\]|\\.)*`/g, '``')            // template literals
        .replace(/'(?:[^'\\]|\\.)*'/g, "''")            // and plain strings
        .replace(/"(?:[^"\\]|\\.)*"/g, '""');

      const defined = new Set();
      for (const m of code.matchAll(/\b(?:function|class)\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);
      for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);
      for (const m of code.matchAll(/\bimport\s*\{([^}]*)\}/g)) {
        for (const n of m[1].split(',')) defined.add(n.trim().split(/\s+as\s+/).pop());
      }
      for (const m of code.matchAll(/\bimport\s+([A-Za-z_$][\w$]*)\s+from/g)) defined.add(m[1]);
      for (const m of code.matchAll(/(?:const|let|var)\s*\{([^}]*)\}/g)) {
        for (const n of m[1].split(',')) defined.add(n.trim().split(':').pop().trim());
      }
      for (const m of code.matchAll(/\(([^)]*)\)\s*=>/g)) {
        for (const n of m[1].split(',')) {
          const t = n.trim().split(/[=\s]/)[0];
          if (t) defined.add(t.replace(/[{}\[\].]/g, ''));
        }
      }
      for (const m of code.matchAll(/function\s*[A-Za-z_$\w]*\s*\(([^)]*)\)/g)) {
        for (const n of m[1].split(',')) {
          const t = n.trim().split(/[=\s]/)[0];
          if (t) defined.add(t);
        }
      }

      for (const m of code.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
        const name = m[2];
        if (!KEYWORD.has(name) && !GLOBAL.has(name) && !defined.has(name)) {
          undefined_.push(`${f}: ${name}()`);
        }
      }
    }
    if (!scanned) bad('the undefined-call scan found no web scripts — it is not looking where it thinks it is');
    else if (undefined_.length) {
      bad('called but defined nowhere', `${[...new Set(undefined_)].join(', ')}\n`
        + '         if these plainly DO exist, the comment stripper ate them: look for an\n'
        + "         apostrophe in a trailing // comment, or a /* inside one. See above.");
    } else {
      ok(`no web script calls a function it does not have (${scanned} files)`);
    }
  }

  /* The two schedulers must agree about the slots.
   *
   * `JOBS` in server.mjs is what actually fires; `JOB_SLOTS` in
   * reminder-dispatch.py is what the missed-job watchdog expects to have
   * fired. Nothing compared them until 2026-09-04, when a third slot was
   * added and both were edited by hand.
   *
   * Either half alone fails silently and in opposite directions. A slot in
   * server.mjs but not in the watchdog is a job that can stop running with
   * nothing to notice — the exact hole the watchdog exists to close. A slot in
   * the watchdog but not in server.mjs is an alert every day for a job that is
   * never due, which is how a channel gets muted. Both are the four-hour
   * outage this whole section was written for.
   *
   * Only scheduled jobs are compared. `days: []` matches no weekday, so those
   * (triage, mail) never fire on the clock and are deliberately absent from the
   * watchdog — JOBS is their allow-list, not their schedule.
   */
  {
    const srv = await read('deploy/agent-service/server.mjs');
    const block = srv.match(/const JOBS = \{([\s\S]*?)\n\};/);
    const fired = new Map();
    if (!block) {
      bad('could not find the JOBS registry in server.mjs — this guard is not looking at anything');
    } else {
      for (const m of block[1].matchAll(/(\w+):\s*\{\s*slot:\s*\[(\d+),\s*(\d+)\][^}]*?days:\s*([^,}]+)/g)) {
        if (m[4].trim() === '[]') continue;             // never fires on the clock
        fired.set(m[1], `${Number(m[2])}:${Number(m[3])}`);
      }
    }

    const py = await read('deploy/reminder-dispatch.py');
    const pyBlock = py.match(/JOB_SLOTS = \{(.*?)\}/s);
    const watched = new Map();
    if (!pyBlock) {
      bad('could not find JOB_SLOTS in reminder-dispatch.py');
    } else {
      for (const m of pyBlock[1].matchAll(/"(\w+)":\s*\((\d+),\s*(\d+)/g)) {
        watched.set(m[1], `${Number(m[2])}:${Number(m[3])}`);
      }
    }

    if (!fired.size || !watched.size) {
      bad('one of the slot registries parsed empty — the comparison below proves nothing');
    } else {
      const problems = [];
      for (const [name, at] of fired) {
        if (!watched.has(name)) problems.push(`${name} fires at ${at} but the watchdog does not know it exists`);
        else if (watched.get(name) !== at) problems.push(`${name}: server.mjs ${at}, watchdog ${watched.get(name)}`);
      }
      for (const name of watched.keys()) {
        if (!fired.has(name)) problems.push(`the watchdog expects ${name}, which no slot fires`);
      }
      if (problems.length) bad('the two schedulers disagree', problems.join('; '));
      else ok(`both schedulers agree on ${fired.size} slots (${[...fired.keys()].join(', ')})`);

      // A slot with no prompt is a job that fires and immediately fails.
      const prompts = new Set((await readdir(join(OBLIGATIONS, 'jobs')))
        .filter((n) => n.endsWith('.md')).map((n) => n.slice(0, -3)));
      const missing = [...fired.keys()].filter((n) => !prompts.has(n));
      if (missing.length) bad(`slot with no jobs/<name>.md: ${missing.join(', ')}`);
      else ok('every scheduled slot has a prompt');
    }
  }

  // Every script a job is told to run must be allowed to run. pipeline-health
  // and close.mjs were both built for jobs and both fell through to a blanket
  // deny; the brief said so itself and could not fix it.
  const wanted = new Set();
  for (const name of await readdir(join(OBLIGATIONS, 'jobs'))) {
    if (!name.endsWith('.md')) continue;
    for (const m of (await read(`jobs/${name}`)).matchAll(/`?node (deploy\/[\w./-]+\.mjs)/g)) {
      wanted.add(m[1]);
    }
  }
  const unallowed = [...wanted].filter(
    (s) => !allow.some((r) => r.startsWith(`Bash(node ${s}`)));
  if (!unallowed.length) ok(`every script the jobs run is allowed (${wanted.size})`);
  else bad('a job runs a script that is not in permissions.allow', unallowed.join(', '));

  // Every asset a served page references must be in the server's allow-list.
  // reference.js needed registering in a second place to exist at all.
  const server = await read('deploy/agent-service/server.mjs');
  const served = new Set([...server.matchAll(/'([\w.-]+\.(?:js|mjs|css))':/g)].map((m) => m[1]));
  const referenced = new Set();
  for (const f of ['dashboard.mjs', 'ui.mjs', 'otp-ui.mjs']) {
    for (const m of (await read(`deploy/agent-service/${f}`)).matchAll(/\/assets\/([\w.-]+)/g)) {
      referenced.add(m[1]);
    }
  }
  const missing = [...referenced].filter((a) => !served.has(a));
  if (!missing.length) ok(`every asset a page loads is served (${referenced.size})`);
  else bad('a page loads an asset the server will 404', missing.join(', '));

  /* ...and every asset ONE ASSET IMPORTS from another.
   *
   * The check above reads `/assets/x` out of the page templates, which is how
   * a script gets a <script> tag. It says nothing about `import { renderProse }
   * from './prose.mjs'` inside one of those scripts — and a relative import is
   * fetched from the same `/assets/` route, so it needs the same entry.
   *
   * Alex, 2026-09-19: "https://obligations.example.com/mail is stuck on
   * loading…". `prose.mjs` had just been split out of said.js so the digest
   * could share it; it was not on the list, so /assets/prose.mjs 404'd and
   * BOTH importers died at module load — the whole page, before a line of it
   * ran. The visual suite missed it because its stub server serves anything
   * under web/, which is more permissive than the real one.
   */
  {
    const web = join(OBLIGATIONS, 'deploy/agent-service/web');
    const imported = new Map();
    for (const f of (await readdir(web)).filter((n) => /\.m?js$/.test(n))) {
      for (const m of (await read(`deploy/agent-service/web/${f}`)).matchAll(/\bfrom\s+'\.\/([\w.-]+)'/g)) {
        if (!imported.has(m[1])) imported.set(m[1], new Set());
        imported.get(m[1]).add(f);
      }
    }
    const dead = [...imported.keys()].filter((a) => !served.has(a));
    if (!dead.length) ok(`every module an asset imports is served (${imported.size})`);
    else bad('an asset imports a module the server will 404 — the importing page will not run at all',
             dead.map((a) => `${a} (imported by ${[...imported.get(a)].join(', ')})`).join('; '));
  }

  // Every nav entry must resolve to a page or an explicit route.
  const nav = [...(await read('deploy/agent-service/nav.mjs'))
    .matchAll(/path:\s*'([^']+)'/g)].map((m) => m[1]);
  const dash = await read('deploy/agent-service/dashboard.mjs');
  const routed = nav.filter((p) =>
    dash.includes(`'${p}':`) || server.includes(`=== '${p}'`) || p === '/');
  if (routed.length === nav.length) ok(`every nav link is routed (${nav.length})`);
  else bad('a nav link goes nowhere', nav.filter((p) => !routed.includes(p)).join(', '));
}

/* ======================================================== 2. WALL CLOCK === */

console.log('\nWall clock: local stamps are not comparable across processes');
{
  // A stamp here is "YYYY-MM-DD HH:MM" with no offset. Parsing one in a process
  // whose TZ differs from the writer's shifts it by the offset: the mail gate
  // read a work list as 242 minutes old when it was 2, and the differ queued 389
  // threads as updated when nothing had moved. Ordering must use an epoch.
  //
  // Each entry is a site that parses a stamp, with why it is safe. A new one
  // fails until someone writes down which process wrote the value it reads.
  const SAFE = {
    'deploy/agent-service/model-gate.mjs':
      'the one stamp parsed is `until` on his own switch — written by the page (which builds it '
      + 'from the browser clock, same box, same zone) or by model-runs.mjs, and compared against '
      + 'this process\'s own now. A pause that ends an hour early or late is a pause that ends; '
      + 'nothing is ordered across a boundary and nothing is stored from it',
    'deploy/agent-service/message-gate.mjs':
      'the same bargain as mail-gate: the work list\'s age comes from its mtime, and the only stamps '
      + 'parsed are ones this box wrote — job-runs.json and the extract stamp, both local',
    'deploy/agent-service/mail-gate.mjs':
      'gap between two stamps this same process wrote (job-runs.json)',
    'deploy/pipeline-health.mjs':
      'ages come from mtime; the one stamp read is job-runs.json, written here',
    'deploy/agent-service/obligations.mjs':
      'due dates are compared as calendar days against local now, never across runs',
    'deploy/digest.mjs':
      'window bound against its own cursor and `reviewed`, both local to this box',
    'deploy/context.mjs':
      'the same comparison drafts.mjs makes, moved into one place so the two '
      + 'cannot drift: a contact stamp against local now, to ask "have they been '
      + 'in touch in the last three days". Every stamp it reads was written on '
      + 'this box in local wall clock — the message and mail extracts and the '
      + 'call log — and the answer is a day-level yes or no for one decision, '
      + 'never stored and never compared across a boundary',
    'deploy/review.mjs':
      'the doubt check asks how many days since the newest of several local stamps — the '
      + 'conclusion\'s own dates, the evidence stamps and contact stamps, all written on this box — '
      + 'against local now; a whole-day answer for one decision, never stored or ordered across a boundary',
    'deploy/digest-window.mjs':
      'the window digest.mjs and brief-input.mjs share. Every stamp it parses was '
      + 'written on this box in local wall clock: `reviewed` by the mail triage, the '
      + 'cursor by digest.mjs --mark, and `surfaced_for` by the triage as a bare '
      + 'YYYY-MM-DD, which is deliberately read as LOCAL midnight so an item dated '
      + 'today is due when the 07:00 brief runs rather than at 20:00 the evening before',
    'deploy/agent-service/server.mjs':
      '/api/today reads calendar startsAt against Date.now() to hide meetings that '
      + 'have already ended; same box, same TZ, a display filter and nothing stored',
    'deploy/priorities.mjs':
      'obligation due dates against local now, to say "due this week"; same box, '
      + 'same TZ, day-level, for a report a human reads',
    'deploy/availability.mjs':
      'calendar startsAt/endsAt against local now, to find free gaps; same box, '
      + 'same TZ, and the output is slots a human reads before offering them',
    'deploy/debrief.mjs':
      'calendar endsAt against Date.now(), to ask twenty minutes after a meeting; '
      + 'same box, same TZ, idempotent through its own sent-list',
    'deploy/prep.mjs':
      'calendar startsAt against Date.now(), both local to this box, to decide '
      + 'whether a meeting is inside the next hour; and .log/prep-sent.json stamps '
      + 'it wrote itself. Nothing crosses a process boundary and nothing is stored '
      + 'that another writer reads',
    'deploy/brief-audit.mjs':
      'compares a brief\'s own `at` stamp with dates written in the same brief by the same job on '
      + 'this box, and a send claim with a draft stamp from the same Gmail account — all local, all display',
    'deploy/agent-service/conditions.mjs':
      'reads `since`/`reviewed` on email-state conclusions, all written by the mail job on this box, '
      + 'to order an alert and its recovery and show minutes open — a display value, nothing stored',
    'deploy/brief-input.mjs':
      'reads `reviewed` (email-state) and the digest cursor to bound a window, and '
      + 'calendar startsOn to pick tomorrow — all written on this box, same TZ; a '
      + 'display document, nothing stored or compared across processes',
    'deploy/agent-service/contact.mjs':
      'compares a message or call stamp from imessage.json, gmail.json and '
      + 'calls.json against a `since` stamp, all written on this box in its own '
      + 'local time. Minute stamps compared as strings within one run, '
      + 'including the same minute on purpose (a call in the minute she said '
      + 'now is good). The result is a line of evidence, not stored state',
    'deploy/lint.mjs':
      'compares a journal filename (YYYY-MM-DD) against a `last-contact` date '
      + 'in a people/ file. Both are dates with no time and no offset, both are '
      + 'written on this box, and the comparison is day-level within one run — '
      + 'the output is a line in the Sunday brief, not state anything stores or '
      + 'orders against another process',
    'deploy/agent-service/location.mjs':
      "parses `since` in unusualStays — a caller's window, either an epoch it "
      + 'passes straight through or a `YYYY-MM-DD 00:00` built from a promise '
      + "date written on this box. Every point it is compared against carries "
      + 'at_ms, so the ordering is epoch-to-epoch; the parse only turns one '
      + 'boundary into a number, in the process that then uses it, and the '
      + 'output is a line in a brief rather than state anything stores',
    'deploy/drafts.mjs':
      "reads `created` on an outbox draft and the last stamp on the thread it "
      + 'answers, both written on this box by the job that wrote the draft, to say '
      + 'how old the draft is in days and whether the other side has written since. '
      + 'The comparison is day-level, inside one run, and the output is a sentence '
      + 'in the brief — nothing is stored or ordered against another process',
    'deploy/conflicts.mjs':
      'every stamp compared here was written on this box in this TZ — obligation '
      + 'due dates, calendar startsOn/startsAt, journal filenames, bookings.md '
      + 'headings. Comparisons are day-level and within one run, never across a '
      + 'process boundary, and the output is a report a human reads rather than '
      + 'state anything else consumes',
    'deploy/agent-service/digestlist.mjs':
      '`conclusion.since` and `thread.watermark`, both written by the mail job on '
      + 'this box in this TZ. Used for a display window and a sort ORDER only, '
      + 'never compared against a stamp from anywhere else — and the page shows '
      + 'the raw string back, so a wrong parse would be visible rather than silent',
    'deploy/agent-service/dashboard.mjs':
      'age of the iMessage extract, written by the Mac and read in the same TZ; '
      + 'shown to a human as "4h old", never used to order anything',
  };
  const found = [];
  for (const dir of ['deploy', 'deploy/agent-service', 'deploy/integrations']) {
    for (const name of await readdir(join(OBLIGATIONS, dir))) {
      if (!/\.mjs$/.test(name) || name.includes('.test.')) continue;
      const rel = `${dir}/${name}`;
      const src = await read(rel);
      // The tell-tale of reading a local stamp. Matched on its own rather than
      // as an argument to Date.parse: the first version required them adjacent,
      // a nested paren broke it, and the guard passed having found NOTHING —
      // which is precisely the failure the section below this one is about.
      if (src.includes("replace(' ', 'T')")) found.push(rel);
    }
  }
  const undocumented = found.filter((f) => !SAFE[f]);
  if (!found.length) {
    bad('the stamp-site scan found nothing — it is not looking where it thinks it is');
  } else if (!undocumented.length) {
    ok(`every stamp-parsing site is accounted for (${found.length})`);
  } else {
    bad('a stamp is parsed somewhere with no note on who wrote it',
        undocumented.join(', ') + ' — add it to SAFE with the reason, or compare an epoch');
  }

  // The extract must carry the epoch sibling, because the differ orders by it.
  let ex = { threads: [] };
  try { ex = JSON.parse(await read('integrations/gmail.json')); } catch { /* no extract on a fresh checkout */ }
  const withEpoch = (ex.threads ?? []).filter((t) => typeof t.watermark_at === 'number');
  if (!ex.threads?.length || withEpoch.length === ex.threads.length) {
    ok('every extract thread carries an epoch watermark');
  } else {
    bad('extract threads without `watermark_at`',
        `${ex.threads.length - withEpoch.length} of ${ex.threads.length}`);
  }
}

/* ===================================================== 3. TEST VALIDITY === */

console.log('\nTest validity: a suite that cannot fail is not a test');
{
  const files = [];
  for (const dir of ['deploy/agent-service', 'deploy/integrations', 'deploy']) {
    for (const name of await readdir(join(OBLIGATIONS, dir))) {
      if (/\.test\.(mjs|py)$/.test(name)) files.push(`${dir}/${name}`);
    }
  }

  // Code below the exit never runs. Seven deadline assertions and this morning's
  // layout guard both shipped that way, green, asserting nothing.
  const dead = [];
  for (const rel of files) {
    const src = await read(rel);
    const i = Math.max(src.lastIndexOf('process.exit('), src.lastIndexOf('sys.exit('));
    if (i === -1) continue;
    const after = src.slice(src.indexOf('\n', i) + 1);
    if (/^\s*(check|ok|bad|assert|console\.log|print)\s*\(/m.test(after)) dead.push(rel);
  }
  if (!dead.length) ok(`no suite has assertions below its exit (${files.length} suites)`);
  else bad('a suite has code after process.exit — it never runs', dead.join(', '));

  // A suite that asserts nothing passes for the wrong reason.
  const thin = [];
  for (const rel of files) {
    // Suites report in two styles: a named helper, or an inline console.log
    // with a counter. access.test.mjs uses the second, and counting only the
    // first said it asserted nothing.
    const src = await read(rel);
    const n = (src.match(/\b(check|ok|bad)\s*\(/g) ?? []).length
            + (src.match(/\b(pass|fail)\s*\+\+/g) ?? []).length;
    if (n < 3) thin.push(`${rel} (${n})`);
  }
  if (!thin.length) ok('every suite makes at least three assertions');
  else bad('a suite asserts almost nothing', thin.join(', '));

  // A suite nothing runs is the quietest test of all: it cannot go red where
  // anyone would see. drafts.test.mjs and scheduling.test.mjs were written on
  // 2026-09-08 and found on 2026-09-15 never to have been in test.sh — a week
  // of changes to the drafting pass with its suite switched off.
  const runners = (await read('deploy/test.sh')) + (await read('deploy/visual.sh'));
  const orphans = files.filter((rel) => !runners.includes(rel.split('/').pop()));
  if (!orphans.length) ok(`every suite is run by test.sh or visual.sh (${files.length})`);
  else bad('a suite exists that no runner runs', orphans.join(', '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
