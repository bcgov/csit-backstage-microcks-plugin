import { Entity } from '@backstage/catalog-model';
import { LocationSpec } from '@backstage/plugin-catalog-common';
import { parse as parseYaml } from 'yaml';
import path from 'path';

const MANAGED_BY_LOCATION_ANNOTATION = 'backstage.io/managed-by-location';
const SOURCE_LOCATION_ANNOTATION = 'backstage.io/source-location';

export type MicrocksMockConfig = {
  mockId?: string;
  includeInSwagger?: boolean;
  artifacts?: Array<{
    kind?: string;
    path?: string;
  }>;
  openapi?: {
    path?: string;
  };
};

export type MicrocksSyncConfig = {
  spec?: {
    mocks?: MicrocksMockConfig[];
  };
};

export type NormalizedMockConfig = {
  mockId: string;
  includeInSwagger: boolean;
  artifacts: Array<{
    kind: string;
    path: string;
  }>;
  openapiOverridePath?: string;
};

export type LocationRef =
  | { kind: 'dir'; dir: string }
  | { kind: 'url'; url: string };

export type BaseLocation =
  | { kind: 'file'; dir: string }
  | { kind: 'url'; baseUrl: URL };

export type OpenApiSource =
  | { kind: 'inline'; text: string }
  | { kind: 'url'; url: string };

export function parseLocationRef(value: string): LocationRef {
  const trimmed = value.trim();

  if (trimmed.startsWith('dir:')) {
    const dir = trimmed.slice('dir:'.length).trim();
    if (!dir) {
      throw new Error(`Invalid value "${value}" (missing dir path)`);
    }
    return { kind: 'dir', dir };
  }

  if (trimmed.startsWith('url:')) {
    const url = trimmed.slice('url:'.length).trim();
    if (!url) {
      throw new Error(`Invalid value "${value}" (missing url)`);
    }
    return { kind: 'url', url };
  }

  throw new Error(
    `Invalid value "${value}" (must start with "dir:" or "url:")`,
  );
}

export function normalizeSafeRelativeDir(dir: string): string {
  const normalized = path.posix.normalize(dir);

  if (
    normalized.startsWith('/') ||
    normalized.startsWith('..') ||
    normalized.includes('/../')
  ) {
    throw new Error(`Invalid dir reference "${dir}"`);
  }

  return normalized;
}

export function isHttpUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://');
}

export function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function parseMocksConfig(text: string): NormalizedMockConfig[] {
  const cfg = parseYaml(text) as MicrocksSyncConfig;
  const rawMocks = cfg?.spec?.mocks;

  if (!Array.isArray(rawMocks) || rawMocks.length === 0) {
    throw new Error(`Missing required spec.mocks array`);
  }

  const mocks = rawMocks.map((raw, index) => {
    const mockId = normalizeNonEmptyString(raw?.mockId);
    if (!mockId) {
      throw new Error(`spec.mocks[${index}].mockId is required`);
    }

    const artifacts = (raw?.artifacts ?? [])
      .map(a => ({
        kind: String(a?.kind ?? '').trim(),
        path: String(a?.path ?? '').trim(),
      }))
      .filter(a => a.kind && a.path);

    const openapiOverridePath =
      normalizeNonEmptyString(raw?.openapi?.path) ?? undefined;

    return {
      mockId,
      includeInSwagger: raw?.includeInSwagger !== false,
      artifacts,
      openapiOverridePath,
    };
  });

  const seen = new Set<string>();
  for (const mock of mocks) {
    if (seen.has(mock.mockId)) {
      throw new Error(`Duplicate mockId "${mock.mockId}" in spec.mocks`);
    }
    seen.add(mock.mockId);
  }

  return mocks;
}

export function toBaseDirFromLocation(location: LocationSpec): BaseLocation {
  if (location.type === 'file') {
    return { kind: 'file', dir: path.dirname(location.target) };
  }

  if (location.type === 'url') {
    const u = new URL(location.target);
    u.pathname = u.pathname.endsWith('/')
      ? u.pathname
      : u.pathname.replace(/\/[^/]*$/, '/');
    return { kind: 'url', baseUrl: u };
  }

  throw new Error(`Unsupported location.type="${(location as any).type}"`);
}

export function getEntityBaseLocation(entity: Entity): BaseLocation {
  const loc =
    entity.metadata.annotations?.[MANAGED_BY_LOCATION_ANNOTATION] ??
    entity.metadata.annotations?.[SOURCE_LOCATION_ANNOTATION];

  if (!loc || typeof loc !== 'string') {
    throw new Error(
      `Entity is missing ${MANAGED_BY_LOCATION_ANNOTATION} or ${SOURCE_LOCATION_ANNOTATION} annotation`,
    );
  }

  if (loc.startsWith('file:')) {
    const p = loc.slice('file:'.length);
    return { kind: 'file', dir: path.dirname(p) };
  }

  if (loc.startsWith('url:')) {
    const u = new URL(loc.slice('url:'.length));
    u.pathname = u.pathname.endsWith('/')
      ? u.pathname
      : u.pathname.replace(/\/[^/]*$/, '/');
    return { kind: 'url', baseUrl: u };
  }

  if (isHttpUrl(loc)) {
    const u = new URL(loc);
    u.pathname = u.pathname.endsWith('/')
      ? u.pathname
      : u.pathname.replace(/\/[^/]*$/, '/');
    return { kind: 'url', baseUrl: u };
  }

  throw new Error(`Unsupported entity base location format: "${loc}"`);
}

export function resolveMicrocksYamlTarget(
  base: BaseLocation,
  ref: LocationRef,
): string {
  if (ref.kind === 'dir') {
    const safeDir = normalizeSafeRelativeDir(ref.dir);

    if (base.kind === 'file') {
      return path.join(base.dir, safeDir, 'microcks.yaml');
    }

    const u = new URL(base.baseUrl.toString());
    const dirPart =
      safeDir === '.'
        ? ''
        : safeDir.replace(/^\.\//, '').replace(/\/?$/, '/');
    u.pathname = u.pathname + dirPart + 'microcks.yaml';
    return u.toString();
  }

  const baseUrl = new URL(ref.url);
  if (!baseUrl.pathname.endsWith('/')) {
    baseUrl.pathname += '/';
  }
  baseUrl.pathname += 'microcks.yaml';
  return baseUrl.toString();
}

export function baseDirOfTarget(target: string): string {
  if (isHttpUrl(target)) {
    const u = new URL(target);
    u.pathname = u.pathname.endsWith('/')
      ? u.pathname
      : u.pathname.replace(/\/[^/]*$/, '/');
    return u.toString();
  }

  return path.dirname(target);
}

export function resolveRelativeTarget(
  baseTarget: string,
  relOrAbs: string,
): string {
  const v = relOrAbs.trim();
  if (!v) {
    return v;
  }

  if (isHttpUrl(v)) {
    return v;
  }

  if (isHttpUrl(baseTarget)) {
    const baseDir = new URL(baseDirOfTarget(baseTarget));
    return new URL(v, baseDir).toString();
  }

  const baseDir = baseDirOfTarget(baseTarget);
  return path.resolve(baseDir, v);
}

export function getOpenApiSourceFromEntity(
  entity: Entity,
): OpenApiSource | undefined {
  const spec: any = entity.spec;
  const def: any = spec?.definition;

  if (typeof def === 'string') {
    return { kind: 'inline', text: def };
  }

  const text = def?.$text;
  if (typeof text === 'string' && text.trim()) {
    const v = text.trim();
    if (isHttpUrl(v)) {
      return { kind: 'url', url: v };
    }
    return { kind: 'inline', text: v };
  }

  return undefined;
}