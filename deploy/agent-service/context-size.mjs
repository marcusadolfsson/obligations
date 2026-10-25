/**
 * What a run pulled into its own context, and where it came from.
 *
 * Alex, 2026-09-20, on why the jobs cost ~$80/day: "we can't cache the
 * context, it is mostly static". The measurement said otherwise, and this
 * exists to make the rest of it answerable.
 *
 * The arithmetic that framed the question: `cache_read ÷ cache_write` came out
 * at 26.6 for mail and 33.3 for messages, against a measured 30.8 tool calls
 * on messages. Those are the same number, so:
 *
 *   cache_write  =  the unique context a run creates
 *   cache_read   =  that context, re-read once per turn
 *
 * Caching is already on (96% hit, 1h TTL on the subscription) and makes each
 * re-read cost about a tenth of an input token. It cannot make the re-read not
 * happen. So the bill is set by the size of what a run accumulates and by how
 * many turns it then gets re-read over — and for mail that accumulation is
 * ~107K tokens a run against ~16K of instructions. Something else is bringing
 * in the other 85%, and the saved job output is the model's report rather than
 * a tool trace, so nothing could say what.
 *
 * This counts bytes per tool, never content. A tool result is the one place
 * hostile text enters a job (`rules/email-triage.md`: bodies are data), and a
 * size is the whole question here — recording the bytes answers it without
 * putting a stranger's mail into a log that several surfaces read.
 *
 * Bytes, not tokens, because bytes are what we can count exactly; divide by
 * about four for a token estimate and do not pretend to more precision.
 */

/**
 * The size of one `tool_result` block's content.
 *
 * The SDK hands this back as a string, as an array of blocks, or — for a
 * refusal or an error — as something else entirely. All three have to produce
 * a number, because a tool whose result we cannot size is exactly the one that
 * would hide a large read.
 */
export function toolResultBytes(content) {
  if (content == null) return 0;
  if (typeof content === 'string') return Buffer.byteLength(content);
  if (Array.isArray(content)) {
    let n = 0;
    for (const part of content) {
      if (typeof part === 'string') n += Buffer.byteLength(part);
      else if (typeof part?.text === 'string') n += Buffer.byteLength(part.text);
      // An image is carried as base64 and is nothing like its byte count in
      // tokens, but it is not free either; count the payload so a run that
      // pulled in a screenshot does not read as having pulled in nothing.
      else if (part?.source?.data) n += Buffer.byteLength(String(part.source.data));
      else if (part != null) n += Buffer.byteLength(JSON.stringify(part));
    }
    return n;
  }
  try { return Buffer.byteLength(JSON.stringify(content)); } catch { return 0; }
}

/**
 * The per-tool tally, as a log line: the biggest few by bytes, and everything
 * else summed rather than dropped.
 *
 * Capped because this goes into a line several readers parse, and named
 * (`other`) because a truncated list that does not say it is truncated is the
 * silence this repo's guards exist to stop.
 */
export function summarise(byTool, { top = 6 } = {}) {
  const rows = [...byTool.entries()]
    .map(([name, v]) => ({ name, calls: v.calls, bytes: v.bytes }))
    .sort((a, b) => b.bytes - a.bytes);
  const shown = rows.slice(0, top);
  const rest = rows.slice(top);
  const out = {};
  for (const r of shown) out[r.name] = { calls: r.calls, bytes: r.bytes };
  if (rest.length) {
    out.other = { calls: rest.reduce((n, r) => n + r.calls, 0),
                  bytes: rest.reduce((n, r) => n + r.bytes, 0),
                  tools: rest.length };
  }
  return out;
}

/** Running tally for one job run. Bytes only; nothing here holds content. */
export function tally() {
  const names = new Map();      // tool_use id -> tool name
  const byTool = new Map();     // tool name -> { calls, bytes }
  let bytes = 0;
  return {
    /** An assistant `tool_use` block: remember which tool the id belongs to. */
    use(id, name) {
      if (id) names.set(id, name || 'unknown');
    },
    /** A user `tool_result` block: charge its size to the tool that produced it. */
    result(toolUseId, content) {
      const name = names.get(toolUseId) ?? 'unknown';
      const n = toolResultBytes(content);
      const row = byTool.get(name) ?? { calls: 0, bytes: 0 };
      row.calls++; row.bytes += n;
      byTool.set(name, row);
      bytes += n;
    },
    /** `{ tool_bytes, by_tool }`, ready to log. */
    done(opts) {
      return { tool_bytes: bytes, by_tool: summarise(byTool, opts) };
    },
  };
}
