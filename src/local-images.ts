import { resolveRuntime, safe } from './podman/client.js';
import type { LocalImage, LocalImagesResponse } from './types.js';

/** dockerode's RepoTags shape — minimal enough to satisfy what we read. */
interface ImageInfo {
  Id: string;
  RepoTags?: string[] | null;
  Size: number;
  Created: number;
}

/**
 * Enumerate locally-pulled images that match the given repository
 * prefix (e.g. "dirkwa/signalk-server" or "ghcr.io/dirkwa/signalk-server").
 * RepoTags is "<repo>:<tag>"; we keep entries whose repo half matches
 * the prefix and explode multi-tag images so each tag is its own row.
 */
export async function listLocalImagesFor(repoPrefixes: string[]): Promise<LocalImagesResponse> {
  const rt = await resolveRuntime();
  if (!rt) return { images: [], totalSize: 0 };

  const r = await safe(() => rt.client.listImages({}));
  if (!r.ok) return { images: [], totalSize: 0 };

  const list = r.value as ImageInfo[];
  const out: LocalImage[] = [];

  for (const img of list) {
    if (!img.RepoTags) continue;
    for (const repoTag of img.RepoTags) {
      const colon = repoTag.lastIndexOf(':');
      if (colon === -1) continue;
      const repo = repoTag.slice(0, colon);
      const tag = repoTag.slice(colon + 1);
      // dockerode marks layered/dangling images as "<none>:<none>";
      // those are not switch targets, drop them.
      if (tag === '<none>' || repo === '<none>') continue;
      // Match either the bare repo or the ghcr-prefixed form.
      const matches = repoPrefixes.some((p) => repo === p || repo === `ghcr.io/${p}`);
      if (!matches) continue;
      out.push({
        tag,
        digest: img.Id,
        created: new Date(img.Created * 1000).toISOString(),
        size: img.Size,
      });
    }
  }

  // Newest first — same ordering as /api/versions does for remote tags.
  out.sort((a, b) => b.created.localeCompare(a.created));

  const totalSize = out.reduce((acc, i) => acc + i.size, 0);
  return { images: out, totalSize };
}
