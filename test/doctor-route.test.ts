import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const DOCTOR_TS = resolve(here, '..', 'src', 'routes', 'doctor.ts');

/**
 * Static guards on src/routes/doctor.ts. The doctor's RuntimeIdentity
 * health probe MUST go through resolveDoctorHealthUrl() — the single
 * resolver state.ts and update-checker.ts already use — NOT a hardcoded
 * `127.0.0.1:3004` fallback.
 *
 * Why this matters: inside the pasta-networked updater container,
 * 127.0.0.1 is the updater's OWN loopback, so a hardcoded fallback probes
 * the updater instead of the doctor. The health tier then fails and
 * getRuntimeIdentity drops to the flaky OCI-label / Quadlet-tag tiers,
 * whose per-request answer makes the doctor's `updateAvailable` flicker
 * between reloads (the Dashboard badge, which uses the resolver, and the
 * Doctor card, which didn't, disagree). This route was the 4th doctor
 * call site and the only one that bypassed the resolver — these static
 * checks force a deliberate look if a future edit reintroduces the trap.
 */
describe('src/routes/doctor.ts health-URL resolution', () => {
  it('imports resolveDoctorHealthUrl from the shared resolver', async () => {
    const src = await readFile(DOCTOR_TS, 'utf8');
    expect(src).toMatch(
      /import\s*\{[^}]*\bresolveDoctorHealthUrl\b[^}]*\}\s*from\s*['"]\.\.\/signalk-url-resolver\.js['"]/,
    );
  });

  it('does NOT hardcode a 127.0.0.1:3004 health URL string in code', async () => {
    const src = await readFile(DOCTOR_TS, 'utf8');
    // Target an actual URL literal (quoted, with the /api/health path),
    // not the prose in the explanatory comment which legitimately names
    // the loopback to describe the bug being avoided.
    expect(src).not.toMatch(/['"]https?:\/\/127\.0\.0\.1:3004/);
  });

  it('builds the doctor target via resolveDoctorHealthUrl()', async () => {
    const src = await readFile(DOCTOR_TS, 'utf8');
    expect(src).toMatch(/healthUrl:\s*await\s+resolveDoctorHealthUrl\(\)/);
  });
});
