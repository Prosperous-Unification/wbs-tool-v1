import type { Tier } from '@tools/deploy-contract';

export interface BundleMeta {
  sha: string;
  tier: Tier;
  builtAt: string;
  images?: string[];
  files: string[];
}

export function bundleName(tier: BundleMeta['tier'], sha: string): string {
  if (!/^[a-f0-9]{7,40}$/.test(sha)) throw new Error(`invalid git sha: ${sha}`);
  return `release-${sha}-${tier}.tar.gz`;
}

export function metaJson(meta: BundleMeta): string {
  return JSON.stringify(meta, null, 2);
}
