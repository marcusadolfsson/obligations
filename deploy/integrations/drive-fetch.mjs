#!/usr/bin/env node
/**
 * Fetch a Drive file to disk with the assistant's own grant, so the chat can attach
 * it to a draft.
 *
 * Alex, 2026-09-06: "And the chat agent can do it now?" — attaching a Drive
 * file to a mail draft. The assistant's Drive scope is drive.file: it sees only
 * files it created, which is every document the mail job filed (the
 * certificates, the statements, the invoices) — the common case for an
 * attachment. Anything else in his Drive the chat reads through the
 * connector instead. Read-only; writes under .log/attachments/, gitignored.
 *
 *   node deploy/integrations/drive-fetch.mjs <fileId> [--out path]
 *   → prints the local path
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accessToken, accountsWith } from '../mcp/google-auth.mjs';

const OBLIGATIONS = process.env.OBLIGATIONS ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export async function fetchDriveFile(vault, fileId, { out = null } = {}) {
  if (!/^[A-Za-z0-9_-]{10,}$/.test(String(fileId ?? ''))) throw new Error('a Drive file id is required');
  const accounts = await accountsWith('drive', vault);
  if (!accounts.length) throw new Error('no account carries the Drive grant');
  let lastErr = null;
  for (const account of accounts) {
    try {
      const token = await accessToken(vault, fetch, account);
      const headers = { Authorization: `Bearer ${token}` };
      const meta = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size`, { headers });
      if (!meta.ok) { lastErr = new Error(`drive ${meta.status} on ${account}: ${meta.status === 404 ? 'not a file the assistant created — read it through the Drive connector instead' : await meta.text().catch(() => '')}`); continue; }
      const { name, mimeType, size } = await meta.json();
      if (Number(size) > 20 * 1024 * 1024) throw new Error(`${name} is ${Math.round(size / 1048576)}MB — over Gmail's attachment size`);
      const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, { headers });
      if (!res.ok) throw new Error(`drive download failed (${res.status})`);
      const data = Buffer.from(await res.arrayBuffer());
      const path = out ?? join(vault, '.log', 'attachments', String(name).replace(/[\/\\]/g, '_'));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, data);
      return { path, name, mimeType, bytes: data.length, account };
    } catch (err) { lastErr = err; }
  }
  throw lastErr ?? new Error('could not fetch');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [fileId] = process.argv.slice(2);
  const oi = process.argv.indexOf('--out');
  try {
    const r = await fetchDriveFile(OBLIGATIONS, fileId, { out: oi > 0 ? process.argv[oi + 1] : null });
    console.log(r.path);
    console.error(`${r.name} · ${r.mimeType} · ${r.bytes} bytes (via ${r.account})`);
  } catch (err) { console.error(`drive-fetch: ${err.message}`); process.exit(1); }
}
