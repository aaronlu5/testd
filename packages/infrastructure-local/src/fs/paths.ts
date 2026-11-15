import { isAbsolute, relative, resolve, sep } from 'node:path';
import { PlatformError } from '@test-platform/core';

/** Resolves `segments` under `root`, rejecting anything that would escape it. */
export const resolveInside = (root: string, ...segments: string[]): string => {
  const base = resolve(root);
  const target = resolve(base, ...segments);
  const rel = relative(base, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
    throw new PlatformError('EXECUTION_ARTIFACT', 'Path escapes the storage root.');
  }
  return target;
};

/** Lower-case, filesystem-safe slug for human-readable file names. */
export const slugify = (value: string): string => {
  const slug = value
    .normalize('NFKD')
    .replace(/\P{ASCII}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : 'untitled';
};
