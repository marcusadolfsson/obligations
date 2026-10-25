#!/usr/bin/env node
/**
 * The switch, from a terminal or the chat.
 *
 * Alex, 2026-09-21: "I am about to run out of claude credits for the week. I
 * want to build a 'Model Enabled' toggle, where we can turn on and off anything
 * that requires a claude model."
 *
 *   node deploy/model-runs.mjs                       # what it is now
 *   node deploy/model-runs.mjs --off --why "out of credits until Monday"
 *   node deploy/model-runs.mjs --off --why "…" --until "2026-09-23 07:00"
 *   node deploy/model-runs.mjs --on
 *
 * **Deliberately on no allow list.** The list means "runs unattended", and an
 * unattended caller that could switch judgement back on is the one caller this
 * must never have — it would undo the switch on the morning of the week he
 * threw it. In chat it stops at an approval card showing the reason; a
 * scheduled job is refused by `canUseTool` before it starts. Same shape as
 * `ignore-sender.mjs`, and for the same reason: a standing rule of his.
 *
 * Reading is free and needs no approval — hence no flag for it.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGate, setGate, statusLine, skipTotal, SPENDERS } from './agent-service/model-gate.mjs';

const OBLIGATIONS = process.env.OBLIGATIONS ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const value = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : null;
};

function report(gate) {
  if (gate.enabled) {
    console.log('Model runs: ON');
    if (gate.expired) console.log(`  came back on by itself — the pause was set to end ${gate.until}`);
    console.log(`  ${Object.values(SPENDERS).join(', ')} all run normally.`);
    return;
  }
  console.log('Model runs: OFF');
  console.log(`  ${statusLine(gate)}`);
  const n = skipTotal(gate);
  if (n) {
    console.log('  skipped so far:');
    for (const [k, v] of Object.entries(gate.skipped ?? {}).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(v).padStart(4)}  ${SPENDERS[k] ?? k}`);
    }
  }
  console.log('  Still running: the minute dispatcher, both differs, the drafts pass,');
  console.log('  the reconciliation\'s own closes, conflicts, prep and the calendar.');
  console.log('  The chat is not gated — it is how you turn this back on.');
}

if (flag('off') || flag('on')) {
  const on = flag('on');
  try {
    const r = await setGate(OBLIGATIONS, {
      enabled: on,
      why: value('why'),
      until: value('until'),
      by: process.env.OBLIGATIONS_ACTOR || 'chat',
    });
    console.log(on
      ? `Model runs are ON again as of ${r.since}.${r.was ? ' (They were already on.)' : ''}`
      : `Model runs are OFF as of ${r.since} — ${r.why}${r.until ? `, back on by itself at ${r.until}` : ''}.`);
    if (!on) console.log('Nothing else stops: mail is still fetched and diffed, reminders still push.');
  } catch (err) {
    console.error(String(err?.message ?? err));
    process.exit(1);
  }
} else {
  report(await readGate(OBLIGATIONS));
}
