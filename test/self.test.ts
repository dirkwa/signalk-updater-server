import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SELF_TS = resolve(here, '..', 'src', 'routes', 'self.ts');

/**
 * Static guards on src/routes/self.ts to lock in the post-incident
 * fix from 2026-05-24: the self-update path must restart the unit via
 * DBus (`restartUnit`), NOT clean-exit via `process.exit(0)`. The old
 * exit-and-pray pattern relied on `Restart=on-failure`, which silently
 * ignores zero exit codes — clean exit, no restart, dead unit.
 *
 * These are static-file assertions because the actual handler does
 * real dockerode/DBus work and isn't unit-testable without heavy
 * mocking. If a future refactor changes either the import shape or
 * the restart mechanism, these tests force a deliberate look here.
 */
describe('src/routes/self.ts self-update restart path', () => {
  it('imports restartUnit from dbus/systemd-user', async () => {
    const src = await readFile(SELF_TS, 'utf8');
    expect(src).toMatch(
      /import\s*\{[^}]*\brestartUnit\b[^}]*\}\s*from\s*['"]\.\.\/dbus\/systemd-user\.js['"]/,
    );
  });

  it('does not call process.exit(0) on the success path', async () => {
    const src = await readFile(SELF_TS, 'utf8');
    // Allow process.exit(1) in the error fallback (when DBus itself
    // fails) but ban exit(0): that's the regressed path. Match both
    // the bare literal and any whitespace variant.
    expect(src).not.toMatch(/process\.exit\(\s*0\s*\)/);
  });

  it('invokes restartUnit with the self unit name', async () => {
    const src = await readFile(SELF_TS, 'utf8');
    expect(src).toMatch(/restartUnit\(\s*SELF_UNIT\s*\)/);
  });
});
