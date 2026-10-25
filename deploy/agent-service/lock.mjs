/**
 * A repo write lock the python side also honours.
 *
 * Two processes edit Alex's markdown files: this service (closing a task,
 * ticking a reminder) and the host dispatcher every minute (nag state, dating
 * new tasks). Both do read-modify-write on whole files, so a collision does not
 * corrupt a file — it silently discards whichever write landed first.
 *
 * The dispatcher already took an flock, which node cannot participate in
 * without a native module. So both sides now also take this one: an O_EXCL
 * create, which is atomic on every filesystem either process will ever see and
 * needs nothing but open(2).
 *
 * A lock older than STALE_MS is broken rather than waited on. The alternative
 * is that one crashed process wedges every write until somebody notices, and
 * the work being protected here is measured in milliseconds.
 */
import { mkdir, open, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const STALE_MS = 60_000;
const WAIT_MS = 5_000;
const POLL_MS = 50;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tryAcquire(path) {
  try {
    const fh = await open(path, 'wx');
    await fh.writeFile(`${process.pid} ${new Date().toISOString()}\n`);
    await fh.close();
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    try {
      const st = await stat(path);
      if (Date.now() - st.mtimeMs > STALE_MS) {
        await unlink(path).catch(() => {});   // someone died holding it
      }
    } catch { /* it went away underneath us; the next attempt will take it */ }
    return false;
  }
}

/**
 * Run `fn` holding the lock. Always releases, including when `fn` throws —
 * a failed close must not wedge the dispatcher.
 */
export async function withRepoLock(vault, fn) {
  // A fresh checkout (or a test's temp repo) has no .log yet; the lock file
  // lives there, so make the directory rather than fail on the first write.
  await mkdir(join(vault, '.log'), { recursive: true }).catch(() => {});
  const path = join(vault, '.log', 'repo.lock');
  const until = Date.now() + WAIT_MS;

  while (!(await tryAcquire(path))) {
    if (Date.now() > until) throw new Error('repo is busy; try again');
    await sleep(POLL_MS);
  }
  try {
    return await fn();
  } finally {
    await unlink(path).catch(() => {});
  }
}
