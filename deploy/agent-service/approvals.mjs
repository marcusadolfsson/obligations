/**
 * Auto-approval: which tools may run in the chat without asking again.
 *
 * Alex, 2026-09-04: "we also need auto approval." Comparing five cabinet bids
 * meant a Drive read per document, and being asked each time on a phone — where
 * a dropped connection also killed the pending question — made a supervised
 * capability unusable in practice.
 *
 * This is a REMEMBERED YES, not a widening. It only ever applies to tools that
 * already reached the approval card, which means:
 *
 *   - never anything in the deny lists — those short-circuit before canUseTool
 *     and are not offered to him at all, so they cannot be remembered either;
 *   - never in a scheduled job — jobs get a blanket deny and never a card, so
 *     nothing here can be reached by an unattended run reading hostile email.
 *
 * The file is `integrations/auto-approve.json`, the same shape and the same
 * reasoning as `integrations/ignored-senders.json`: a small record of a
 * decision Alex made by pressing a button, which the agent reads and never
 * writes to on its own behalf.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withRepoLock } from './lock.mjs';
import { localStamp } from './time.mjs';

const FILE = ['integrations', 'auto-approve.json'];

/* Tools that may NEVER be remembered, however often he is asked.
 *
 * The test is not "is this dangerous" — the dangerous ones are denied outright
 * and never get here. It is **does the same tool name mean the same thing every
 * time it is called**. "Always allow Bash" is not a decision about a tool, it
 * is a decision about every command anyone can ever put in one, including a
 * command an injected email body suggests. Same for a tool that takes a
 * destination: approving one WebFetch is not approving every URL.
 *
 * So: anything whose payload is the actual decision cannot be remembered, and
 * anything that acts outward as Alex cannot be remembered. He can still say
 * yes to each one; he just has to see each one.
 */
const NEVER_REMEMBER = [
  /^Bash$/,                       // the command is the decision, not the tool
  /^WebFetch$/, /^WebSearch$/,    // the destination is the decision
  /^Write$/, /^Edit$/, /^NotebookEdit$/,
  /send/i, /reply/i, /forward/i,  // acts outward as him — always a fresh yes
  /delete/i, /trash/i, /spam/i, /remove/i,
  /share/i, /archive/i, /modify/i, /update/i, /create/i, /batch/i,
];

/**
 * May this tool be offered an "always" button?
 *
 * Read-shaped MCP tools qualify: get_, list_, search_, read_. A read brings
 * data in rather than sending anything out, its name fully describes what it
 * does, and it is the class that generated the repetition he is complaining
 * about. Everything else gets Approve/Deny only.
 */
export function canRemember(tool) {
  const name = String(tool ?? '');
  if (!name) return false;
  if (NEVER_REMEMBER.some((re) => re.test(name))) return false;
  const verb = name.startsWith('mcp__') ? name.split('__').slice(2).join('__') : name;
  return /^(get|list|search|read|fetch_thread|query)/i.test(verb) || /^(Read|Glob|Grep)$/.test(name);
}

/** The remembered set. Absence is an empty set, never an error. */
export async function autoApproved(vault) {
  try {
    const d = JSON.parse(await readFile(join(vault, ...FILE), 'utf8'));
    return new Set(Object.keys(d?.tools ?? {}));
  } catch {
    return new Set();
  }
}

/**
 * Remember a yes. Refuses anything canRemember() rejects — the button is only
 * rendered for tools that qualify, but the check belongs on this side too: a
 * client is something a browser sends, not something to trust.
 */
export async function remember(vault, tool, { by = 'web' } = {}) {
  const name = String(tool ?? '').trim();
  if (!name || !canRemember(name)) {
    throw new Error(`${name || '(empty)'} may not be auto-approved`);
  }
  await withRepoLock(vault, async () => {
    const path = join(vault, ...FILE);
    let d;
    try { d = JSON.parse(await readFile(path, 'utf8')); } catch { d = { tools: {} }; }
    d.tools ??= {};
    if (!d.tools[name]) {
      d.tools[name] = { since: localStamp(), by };
      await writeFile(path, JSON.stringify(d, null, 2) + '\n');
    }
  });
  return { tool: name };
}

/** Forget one, or all of them. He can take a yes back. */
export async function forget(vault, tool = null) {
  let removed = 0;
  await withRepoLock(vault, async () => {
    const path = join(vault, ...FILE);
    let d;
    try { d = JSON.parse(await readFile(path, 'utf8')); } catch { return; }
    d.tools ??= {};
    if (tool === null) { removed = Object.keys(d.tools).length; d.tools = {}; }
    else if (d.tools[tool]) { delete d.tools[tool]; removed = 1; }
    if (removed) await writeFile(path, JSON.stringify(d, null, 2) + '\n');
  });
  return { removed };
}
