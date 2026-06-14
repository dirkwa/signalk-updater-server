import type { ImageState } from './types';

/** Combine the two image-state signals into the one to display/act on.
 *  `/api/state` is the instant, network-free signal (so it carries
 *  'restart-required' the moment a pull happens), while
 *  `/api/updates/available` is refreshed on the GHCR cadence (so it's the
 *  only one that ever reports 'pull-available'). When they disagree, take
 *  the union: a tag can have moved on GHCR (pull-available, from updates)
 *  AND have a pulled-but-not-restarted image (restart-required, from
 *  state) at the same time → 'pull-and-restart'.
 *
 *  Shared by the Dashboard card banner and the Versions in-use row so
 *  both surfaces agree on whether a movable tag (`:dirkwa`, `:master`,
 *  `:latest`) is actually current — the semver never moves between those
 *  builds, so this digest-derived state is the only honest signal. */
export function mergeImageState(
  fromState: ImageState | undefined,
  fromUpdates: ImageState | undefined,
): ImageState {
  const restart =
    fromState === 'restart-required' ||
    fromState === 'pull-and-restart' ||
    fromUpdates === 'restart-required' ||
    fromUpdates === 'pull-and-restart';
  const pull =
    fromState === 'pull-available' ||
    fromState === 'pull-and-restart' ||
    fromUpdates === 'pull-available' ||
    fromUpdates === 'pull-and-restart';
  if (restart && pull) return 'pull-and-restart';
  if (pull) return 'pull-available';
  if (restart) return 'restart-required';
  // Neither found drift. If at least one side gave a definite 'in-sync',
  // report that; otherwise we genuinely don't know.
  if (fromState === 'in-sync' || fromUpdates === 'in-sync') return 'in-sync';
  return 'unknown';
}
