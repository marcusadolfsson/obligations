/**
 * The chat page. Markup only — styling is web/style.css + web/chat.css, and the
 * behaviour is web/chat.js.
 *
 * Nothing is inline here. Inline JS previously sat inside a template literal, so
 * every escape was processed twice and one of them broke the whole script.
 * Inline CSS meant three pages carrying three drifting copies of one palette.
 *
 * The layout is a fixed-height flex column: bar, scrolling transcript, composer.
 * That is load-bearing. With min-height on the body instead, the *body* becomes
 * the scroller on mobile, so log.scrollTop = log.scrollHeight sets a property on
 * an element that is not scrolling — which is exactly why the page did not open
 * at the newest message on a phone.
 */
import { nav, tools } from './nav.mjs';

const MIC = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" ` +
  `stroke="currentColor" stroke-width="1.7" stroke-linecap="round" ` +
  `stroke-linejoin="round" aria-hidden="true">` +
  `<rect x="9" y="2.5" width="6" height="11" rx="3"/>` +
  `<path d="M5.5 11.5a6.5 6.5 0 0 0 13 0"/><path d="M12 18v3.2"/></svg>`;

export const PAGE = `<!doctype html><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>obligations</title>
<script>try{var t=localStorage.getItem('obligations.theme');if(t)document.documentElement.dataset.theme=t}catch(e){}</script>
<link rel=stylesheet href="/assets/style.css">
<link rel=stylesheet href="/assets/chat.css">

<div class="wrap wide chatpage">
<div class=top>
  <a class=brand href="/">obligations</a>
  ${nav('/chat', 0)}
  ${tools('<button class="pill nav-new" id=newchat type=button ' +
          'title="Start a fresh conversation. The old transcript is kept.">new</button>')}
</div>
<div class=pagehead>
  <h1>chat</h1>
  <span class=stamp id=stamp>__STAMP__</span><span class=mut id=sid hidden></span>
</div>

<div id=outbox></div>
<div id=log></div>
</div>

<div class=dock>
 <div class=dockinner>
  <form id=f>
   <div class=composer>
    <button class=icon id=jump type=button title="Jump to latest">\u2193</button>
    <textarea id=t rows=1 placeholder="Message the assistant"></textarea>
    <div id=chips></div>
    <div class=controls>
      <button class=icon id=clip type=button title="Attach a file">+</button>
      <input id=file type=file multiple hidden>
      <select id=model title="Model for the next turn"></select>
      <span class=spacer></span>
      <button class=icon id=mic type=button title="Dictate" hidden aria-label="Dictate">${MIC}</button>
      <button class=icon id=stop type=button title="Stop this turn">\u25a0</button>
      <button class="icon send" id=b type=submit title="Send">\u2191</button>
    </div>
   </div>
  </form>
  <div id=status></div>
 </div>
</div>

<script type=module src="/assets/chat.js"></script>
`;
