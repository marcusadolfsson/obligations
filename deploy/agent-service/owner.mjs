/**
 * Who the assistant works for. Every prompt that names the owner reads it from
 * here, so a new install sets OWNER_NAME in deploy/.env and nothing else.
 * The default is the example owner the docs and tests are written about.
 */
export const OWNER_NAME = (process.env.OWNER_NAME || 'Alex Rivera').trim();
export const OWNER_FIRST = (process.env.OWNER_FIRST || OWNER_NAME.split(/\s+/)[0]).trim();
