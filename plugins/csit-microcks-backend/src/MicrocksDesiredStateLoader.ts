import type { LoggerService, UrlReaderService } from '@backstage/backend-plugin-api';
import { CatalogClient } from '@backstage/catalog-client';
import { parse as parseYaml } from 'yaml';
import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const ANNOTATION = 'bcgov/microcks-config-ref';
const MICROCKS_FILE = 'microcks.yaml';

type MicrocksMockConfig = {
  mockId?: string;
  artifacts?: Array<{ kind?: string; path?: string }>;
  openapi?: { path?: string };
};

type MicrocksSyncConfig = {
  spec?: {
    mocks?: MicrocksMockConfig[];
  };
};

type NormalizedMockConfig = {
  mockId: string;
  artifacts: Array<{ kind: string; path: string }>;
  openapiOverridePath?: string;
};

type LocationRef =
  | { kind: 'dir'; dir: string }
  | { kind: 'url'; url: string };

type BaseLocation =
  | { kind: 'file'; dir: string }
  | { kind: 'url'; baseUrl: URL };

type OpenApiSource =
  | { kind: 'inline'; text: string }
  | { kind: 'url'; url: string };

export type StagedArtifact = {
  filename: string;
  path: string;
};

export type LoadedDesiredState = {
  mockId: string;
  allMockIds: string[];
  entityName: string;
  desiredApiName: string;
  tempDir: string;
  mainArtifact: StagedArtifact;
  secondaryArtifacts: StagedArtifact[];
};

function getFilenameFromTarget(target: string, fallback: string): string {
  const value = (target ?? '').trim();
  if (!value) return fallback;

  if (isHttpUrl(value)) {
    const u = new URL(value);
    const name = path.posix.basename(u.pathname);
    return name || fallback;
  }

  const name = path.basename(value);
  return name || fallback;
}

function sanitizeFilename(filename: string): string {
  const trimmed = (filename ?? '').trim();
  const base = trimmed ? path.basename(trimmed) : 'artifact.yaml';
  return base.replace(/[^A-Za-z0-9._-]/g, '_');
}

async function stageArtifactFile(
  tempDir: string,
  index: number,
  filename: string,
  content: string,
): Promise<StagedArtifact> {
  const safeName = sanitizeFilename(filename);
  const stagedPath = path.join(tempDir, `${String(index).padStart(3, '0')}-${safeName}`);
  await fs.writeFile(stagedPath, content, 'utf8');

  return {
    filename,
    path: stagedPath,
  };
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function isHttpUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://');
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function parseLocationRef(value: string): LocationRef {
  const trimmed = value.trim();

  if (trimmed.startsWith('dir:')) {
    const dir = trimmed.slice('dir:'.length).trim();
    if (!dir) throw new Error(`Invalid value "${value}" (missing dir path)`);
    return { kind: 'dir', dir };
  }

  if (trimmed.startsWith('url:')) {
    const url = trimmed.slice('url:'.length).trim();
    if (!url) throw new Error(`Invalid value "${value}" (missing url)`);
    return { kind: 'url', url };
  }

  throw new Error(`Invalid value "${value}" (must start with "dir:" or "url:")`);
}

function normalizeSafeRelativeDir(dir: string): string {
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

function getEntityBaseLocation(entity: any): BaseLocation {
  const loc =
    entity?.metadata?.annotations?.['backstage.io/managed-by-location'] ??
    entity?.metadata?.annotations?.['backstage.io/source-location'];

  if (!loc || typeof loc !== 'string') {
    throw new Error(
      'Entity is missing backstage.io/managed-by-location or backstage.io/source-location annotation',
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

function resolveMicrocksYamlTarget(base: BaseLocation, ref: LocationRef): string {
  if (ref.kind === 'dir') {
    const safeDir = normalizeSafeRelativeDir(ref.dir);

    if (base.kind === 'file') {
      return path.join(base.dir, safeDir, MICROCKS_FILE);
    }

    const u = new URL(base.baseUrl.toString());
    const dirPart =
      safeDir === '.'
        ? ''
        : safeDir.replace(/^\.\//, '').replace(/\/?$/, '/');
    u.pathname = u.pathname + dirPart + MICROCKS_FILE;
    return u.toString();
  }

  const baseUrl = new URL(ref.url);
  if (!baseUrl.pathname.endsWith('/')) baseUrl.pathname += '/';
  baseUrl.pathname += MICROCKS_FILE;
  return baseUrl.toString();
}

function baseDirOfTarget(target: string): string {
  if (isHttpUrl(target)) {
    const u = new URL(target);
    u.pathname = u.pathname.endsWith('/')
      ? u.pathname
      : u.pathname.replace(/\/[^/]*$/, '/');
    return u.toString();
  }
  return path.dirname(target);
}

function resolveRelativeTarget(baseTarget: string, relOrAbs: string): string {
  const v = (relOrAbs ?? '').trim();
  if (!v) return v;

  if (isHttpUrl(v)) return v;

  if (isHttpUrl(baseTarget)) {
    const baseDir = new URL(baseDirOfTarget(baseTarget));
    return new URL(v, baseDir).toString();
  }

  const baseDir = baseDirOfTarget(baseTarget);
  return path.resolve(baseDir, v);
}

function getOpenApiSourceFromEntity(entity: any): OpenApiSource | undefined {
  const def = entity?.spec?.definition;

  if (typeof def === 'string' && def.trim()) {
    const v = def.trim();
    if (isHttpUrl(v)) return { kind: 'url', url: v };
    return { kind: 'inline', text: v };
  }

  const text = def?.$text;
  if (typeof text === 'string' && text.trim()) {
    const v = text.trim();
    if (isHttpUrl(v)) return { kind: 'url', url: v };
    return { kind: 'inline', text: v };
  }

  return undefined;
}

function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function parseMocksConfig(text: string): NormalizedMockConfig[] {
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

export class MicrocksDesiredStateLoader {
  constructor(
    private readonly logger: LoggerService,
    private readonly catalog: CatalogClient,
    private readonly urlReader: UrlReaderService,
  ) {}

  private async readText(target: string): Promise<string> {
    try {
      let text: string;

      if (isHttpUrl(target)) {
        const resp = await this.urlReader.readUrl(target);
        const buf = await resp.buffer();
        text = buf.toString('utf8');
      } else {
        text = await fs.readFile(target, 'utf8');
      }

      return text;
    } catch (e) {
      const msg = errorMessage(e);

      this.logger.error(
        `[csit-microcks-desired-state-loader] failed to read target=${target}: ${msg}`,
      );

      if (isHttpUrl(target) && /not allowed|disallowed|allow list|allowedHosts/i.test(msg)) {
        this.logger.error(
          [
            '============================================================',
            '[csit-microcks-desired-state-loader] URL READ BLOCKED (backend.reading.allow?)',
            `target: ${target}`,
            '',
            'This usually means Backstage UrlReader is blocking the host.',
            'Add the host to your backend.reading.allow list, e.g.:',
            '',
            'backend:',
            '  reading:',
            '    allow:',
            '      - host: raw.githubusercontent.com',
            '      - host: authz-b8840c-dev.apps.gold.devops.gov.bc.ca',
            '      - host: csit-microcks-apps-gov-bc-ca.dev.api.gov.bc.ca',
            '',
            `Error: ${msg}`,
            '============================================================',
          ].join('\n'),
        );
      }

      throw e;
    }
  }

  async load(entityRef: string, mockId: string): Promise<LoadedDesiredState> {
    const entity = await this.catalog.getEntityByRef(entityRef);
    if (!entity) {
      throw new Error(`Catalog entity not found: ${entityRef}`);
    }

    const entityName =
      typeof entity.metadata?.name === 'string' && entity.metadata.name.trim()
        ? entity.metadata.name.trim()
        : undefined;

    if (!entityName) {
      throw new Error(`Catalog entity is missing metadata.name for entity=${entityRef}`);
    }

    const rawRef = entity.metadata?.annotations?.[ANNOTATION];
    if (!rawRef) {
      throw new Error(`Entity missing annotation ${ANNOTATION}`);
    }

    const base = getEntityBaseLocation(entity);
    const locRef = parseLocationRef(String(rawRef));
    const microcksTarget = resolveMicrocksYamlTarget(base, locRef);

    const microcksText = await this.readText(microcksTarget);

    let mocks: NormalizedMockConfig[];
    try {
      mocks = parseMocksConfig(microcksText);
    } catch (e) {
      throw new Error(`Invalid microcks.yaml: ${errorMessage(e)}`);
    }

    const allMockIds = mocks.map(m => m.mockId);

    const selectedMock = mocks.find(m => m.mockId === mockId);
    if (!selectedMock) {
      throw new Error(
        `Mock "${mockId}" not found in microcks.yaml for entity=${entityRef}`,
      );
    }

    const artifacts = selectedMock.artifacts;
    const openapiOverride = selectedMock.openapiOverridePath;

    let openapi: OpenApiSource | undefined;
    let openapiFilename = 'openapi.yaml';

    if (openapiOverride) {
      const resolvedOpenapi = resolveRelativeTarget(microcksTarget, openapiOverride);
      openapi = {
        kind: 'url',
        url: resolvedOpenapi,
      };
      openapiFilename = getFilenameFromTarget(resolvedOpenapi, 'openapi.yaml');
    } else {
      openapi = getOpenApiSourceFromEntity(entity);

      if (openapi?.kind === 'url') {
        openapiFilename = getFilenameFromTarget(openapi.url, 'openapi.yaml');
      }
    }

    let openapiText: string | undefined;
    const loadedSecondaryArtifacts: Array<{ filename: string; content: string }> = [];

    this.logger.info(
      `[csit-microcks-desired-state-loader] inputs loaded entity=${entityRef} microcksSource=${microcksTarget} microcksHash=${sha256(
        microcksText,
      )} mockId=${mockId} allMockIds=${allMockIds.join(',')} artifacts=${artifacts.length}`,
    );

    for (const a of artifacts) {
      const resolved = resolveRelativeTarget(microcksTarget, a.path);
      const text = await this.readText(resolved);
      const hash = sha256(text);
      const filename = getFilenameFromTarget(resolved, `${a.kind || 'artifact'}.yaml`);

      loadedSecondaryArtifacts.push({
        filename,
        content: text,
      });

      this.logger.info(
        `[csit-microcks-desired-state-loader] artifact ok kind=${a.kind} path=${a.path} resolved=${resolved} hash=${hash}`,
      );
    }

    if (openapi) {
      if (openapi.kind === 'inline') {
        openapiText = openapi.text;
      } else {
        const t = openapi.url;
        const resolved = isHttpUrl(t)
          ? t
          : resolveRelativeTarget(microcksTarget, t);
        const text = await this.readText(resolved);
        const hash = sha256(text);
        openapiText = text;
        openapiFilename = getFilenameFromTarget(resolved, openapiFilename);
        this.logger.info(
          `[csit-microcks-desired-state-loader] openapi ok source=url resolved=${resolved} hash=${hash}`,
        );
      }
    } else {
      this.logger.info('[csit-microcks-desired-state-loader] openapi none');
    }

    if (!openapiText) {
      throw new Error(
        `Unable to resolve OpenAPI document for entity=${entityRef} mockId=${mockId}. A main artifact is required for Microcks upload.`,
      );
    }

    const desiredApiName = entityName;

    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'csit-microcks-sync-'),
    );

    const mainArtifact = await stageArtifactFile(
      tempDir,
      0,
      openapiFilename,
      openapiText,
    );

    const secondaryArtifacts: StagedArtifact[] = [];
    for (let i = 0; i < loadedSecondaryArtifacts.length; i++) {
      const artifact = loadedSecondaryArtifacts[i];
      secondaryArtifacts.push(
        await stageArtifactFile(
          tempDir,
          i + 1,
          artifact.filename,
          artifact.content,
        ),
      );
    }

    this.logger.info(
      `[csit-microcks-desired-state-loader] staged artifacts entity=${entityRef} mockId=${mockId} tempDir=${tempDir} mainArtifact="${mainArtifact.filename}" secondaryArtifacts=${secondaryArtifacts.length} desiredApiName="${desiredApiName}" entityName="${entityName}" allMockIds=${allMockIds.join(',')}`,
    );

    return {
      mockId,
      allMockIds,
      entityName,
      desiredApiName,
      tempDir,
      mainArtifact,
      secondaryArtifacts,
    };
  }
}