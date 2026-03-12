import type { LoggerService, UrlReaderService } from '@backstage/backend-plugin-api';
import { CatalogClient } from '@backstage/catalog-client';
import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  type NormalizedMockConfig,
  type OpenApiSource,
  getOpenApiSourceFromEntity,
  getEntityBaseLocation,
  isHttpUrl,
  parseLocationRef,
  parseMocksConfig,
  resolveMicrocksYamlTarget,
  resolveRelativeTarget,
} from './MicrocksConfigUtils';

const ANNOTATION = 'bcgov/microcks-config-ref';

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

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
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