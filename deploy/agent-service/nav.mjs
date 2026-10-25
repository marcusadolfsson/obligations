/**
 * The navigation, defined once.
 *
 * It had drifted to three different sets in three different orders across three
 * files, and the test that caught that could only compare strings — it could not
 * stop the drift. One list can't drift.
 *
 * The dashboard used to be a single scrolling page holding reminders, tasks,
 * notes and machine state. On a phone that is a wall you scroll past to reach
 * the one thing you opened it for, so each section is its own page and the menu
 * is how you get to it.
 *
 * Reminders live on the tasks page rather than beside it: a reminder with a due
 * date and an unanswered message are both "a thing that is owed", and splitting
 * them across two pages meant neither page could answer "what is outstanding".
 * Notifications is what `messages/` is called in the UI — the directory keeps
 * its name, but on screen these are things the system said to Alex.
 */
// No chat entry: the chat is the corner button on every page (web/drawer.js),
// and "/" is still served for the full-page version and the drawer's own
// "open full" link. Alex, 2026-09-03: "remove the chat link in the header."
// Alex, 2026-09-06: "Said to you should be Briefs, and put it after Today.
// Then Work rename To Do." Paths stay — they are on his home screen and in
// every push — only the words changed.
export const NAV = [
  // Alex, 2026-09-05: "ten tabs is a filing cabinet."
  // Today is the desk; Work holds tasks, decisions and priorities as filters;
  // People is the graph; Digest is everything judged or said, in one stream;
  // Chat is the full-screen conversation. Everything else is under `more`.
  { path: '/',       label: 'today' },
  { path: '/briefs',   label: 'briefs' },
  { path: '/todo',   label: 'to do' },
  { path: '/people', label: 'people' },
  { path: '/mail',   label: 'mail' },
  /* Alex, 2026-09-19: "move Reference in the menu to after mail." It sat
     under `more` as something consulted rather than visited, and the four
     questions made that wrong: `memory` is the tier for a fact he will go
     LOOKING for — an amount, an order number, a confirmation — and the place
     he goes looking is this page. A destination behind a menu is one he has to
     remember exists. Next to mail, because it is where mail's facts end up. */
  { path: '/reference', label: 'reference' },
  { path: '/chat',   label: 'chat' },
];

/** Consulted, not visited: reachable, out of the way. Still served, still in tests. */
// The outbox left this list on 2026-09-19. Alex: "Lets merge the outbox
// into To Do. It should be more of a filter" — so a draft waiting to go out is
// an attribute of the task it discharges, and `/outbox` redirects to
// `/todo?f=drafted`. Its count rode on the To Do pill for an afternoon, until:
// "to do should not show (4), that is the number of drafts." A number on a
// pill takes its meaning from the word beside it, and beside "to do" that one
// reads as the task count. It lives on the `drafted` filter now, where the
// word next to it says what it counts.
export const MORE = [
  // `/reference` is a destination now — see NAV above. Listing it in both
  // would put it on a phone's tab bar and inside the `more` sheet at once.
  { path: '/system',     label: 'system' },
];

/* SUB-PAGES. Alex, 2026-09-30: "move priorities to under to-do. Move notes
   to under system." Each is still its own page at its own path — on his home
   screen and in links from briefs and People — but reached from its parent
   (To Do's filter row, the top of System) rather than from the menu, and the
   menu marks the parent while he is on one. */
export const PARENT = { '/projects': '/todo', '/notes': '/system' };

/**
 * @param current  pathname of the page being rendered — gets aria-current
 * @param unread   badge on `briefs`; 0 renders no badge
 *
 * One `<nav>`, two shapes. Alex, 2026-09-19: "make the Obligations UI feel nicer …
 * right now it feels very component code driven." Twelve identical pills in a
 * row was the first thing on every page, and on a phone it wrapped to three
 * rows and spent the top fifth of the screen before anything he came for. So on
 * a wide screen the six destinations are text links on one rule, with the
 * five consulted pages after a divider; on a phone the same `<nav>` is fixed
 * to the bottom as a tab bar — where a thumb already is — and the five are
 * behind a `more` tab that opens upward. Both are the same markup; CSS picks.
 *
 * The consulted pages appear TWICE on purpose: once inline for the wide layout
 * and once inside the `<details>` for the phone. A `<details>` cannot be told
 * to render its contents while closed, and a script to toggle a menu would
 * have to be loaded on the chat page as well. The id stays on the inline copy,
 * which is the one the desktop shows.
 */
export function nav(current, unread = 0) {
  current = PARENT[current] ?? current;
  const link = ({ path, label }, cls, withId = true) => {
    const here = path === current ? ' aria-current=page' : '';
    // The id stays so the chat page can update the unread count client-side
    // as briefs arrive.
    /* No count on To Do. Alex, 2026-09-19: "to do should not show (4), that
     * is the number of drafts." It is — and on a pill labelled "to do" it
     * reads as the number of tasks, which is 200-odd. The drafts count lives
     * on the `drafted` filter, where the word beside it says what it counts. */
    const id = !withId ? '' : path === '/briefs' ? ' id=msglink' : '';
    const n = path === '/briefs' ? unread : 0;
    // The count is its own element, not text in the label. Alex,
    // 2026-09-19: "i see briefs (3) then click on it it becomes briefs" — on
    // the phone the current tab is bold, the tab is 55px wide, and the bold
    // label pushed "(3)" out of the clipped box. A badge is placed by CSS and
    // cannot be pushed; it is empty (and hidden) when there is nothing.
    const badge = path === '/briefs' ? `<b class=navbadge>${n || ''}</b>` : '';
    return `<a class="${cls}" href="${path}"${id}${here}>${label}${badge}</a>`;
  };
  const links = NAV.map((n) => link(n, 'pill nl')).join('\n    ');
  const inline = MORE.map((n) => link(n, 'pill nav-more')).join('\n      ');
  const sheet = MORE.map((n) => link(n, 'pill nav-more', false)).join('\n        ');
  const moreHere = MORE.some((n) => n.path === current);
  return `<nav class=links>
    ${links}
    <span class=more-inline>
      ${inline}
    </span>
    <details class=more id=navmore>
      <summary class="pill nl"${moreHere ? ' aria-current=page' : ''}>more</summary>
      <div class=more-menu>
        ${sheet}
      </div>
    </details>
  </nav>`;
}

/**
 * The controls that are not destinations: the theme switch, search (mounted
 * here by web/search.mjs), and a page's own button (chat's "new"). They sit at
 * the right of the masthead on every layout, so they never become a tab.
 */
export function tools(extra = '') {
  // The theme toggle. Its label is what you would switch TO, so the button
  // says what pressing it does rather than what you are looking at — the
  // ambiguity in every sun/moon icon that shows the current state instead.
  // web/drawer.js fills the label in once it knows what is in effect.
  const theme = '<button class="pill nav-theme" id=themetoggle type=button '
    + 'title="Switch between light and dark" aria-label="Switch theme">theme</button>';
  return `<span class=navtools id=navtools>${extra ? extra + '\n    ' : ''}${theme}</span>`;
}
