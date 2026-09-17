import type { Tier } from '@tools/deploy-contract';

export interface ImageSpec {
  tier: Tier;
  baseImage: string;
  entrypoint: string[];
  workdir: string;
}

export const DEFAULT_IMAGES: Record<ImageSpec['tier'], ImageSpec> = {
  be: {
    tier: 'be',
    baseImage: 'oven/bun:1.2-debian',
    entrypoint: ['bun', 'run', 'src/main.ts'],
    workdir: '/app/apps/wbs/be-01',
  },
  gw: {
    tier: 'gw',
    baseImage: 'oven/bun:1.2-debian',
    entrypoint: ['bun', 'run', 'src/main.ts'],
    workdir: '/app/apps/wbs/gw-01',
  },
  fe: {
    tier: 'fe',
    baseImage: 'caddy:2-alpine',
    entrypoint: ['caddy', 'run', '--config', '/etc/caddy/Caddyfile'],
    workdir: '/srv',
  },
};
