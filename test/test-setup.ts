import { vi } from 'vitest';

/**
 * Server-suite setup: keep unit tests off the network.
 *
 * `createServer()` calls `startUpdateChecker()`, which fires a GHCR tag query
 * for both engine images immediately at boot — fire-and-forget, so it does not
 * slow `createServer` measurably, but it does mean seven test files reach
 * ghcr.io over the internet to exercise local routes.
 *
 * That matters for three reasons, none of them speed:
 *
 *   - Rate budget. update-checker.ts sizes its 24h interval against ghcr.io's
 *     ~50 req/h per-IP allowance, calling it "~2 per day". The suite fires ~12
 *     per run from the same IP, so a few consecutive runs can eat the budget
 *     the product itself depends on. Running the full suite four times while
 *     chasing a flake got within sight of it.
 *   - Determinism. A test whose behaviour depends on whether ghcr.io answers
 *     is not a unit test. On a boat — offline, or on a metered link — the same
 *     suite behaves differently, which is precisely where a green run matters
 *     most.
 *   - Noise. Failed boot checks log warnings into unrelated test output.
 *
 * Stubbed globally rather than per-file because the dependency is structural:
 * it arrives through `createServer()`, so every test that builds a server
 * inherits it, and expecting each new one to remember the stub is how six of
 * the seven ended up without it.
 *
 * A test that genuinely wants the real checker can still re-mock or unmock the
 * module itself; this only changes the default. No test currently does — the
 * files that reference update-checker all stub it already.
 */
/**
 * Only `startUpdateChecker` is replaced; everything else stays real.
 *
 * A whole-module factory would have to re-implement each export's contract,
 * and getting one wrong is worse than the problem being solved: an early
 * draft of this file stubbed `getCachedUpdates` to return null, where the
 * real one returns a shaped AvailableUpdates that routes destructure. That
 * would have failed unrelated tests for a reason with nothing to do with
 * them.
 *
 * The network call comes from startUpdateChecker's immediate triggerCheck, so
 * neutralising that one export is sufficient and leaves the module's real
 * behaviour available to anything that tests it directly.
 */
vi.mock('../src/update-checker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/update-checker.js')>();
  return { ...actual, startUpdateChecker: vi.fn() };
});
