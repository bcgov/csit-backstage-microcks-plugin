import {
  CatalogProcessor,
  CatalogProcessorEmit,
} from '@backstage/plugin-catalog-node';
import { Entity, stringifyEntityRef } from '@backstage/catalog-model';
import type {
  LoggerService,
  UrlReaderService,
} from '@backstage/backend-plugin-api';
import { LocationSpec } from '@backstage/plugin-catalog-common';
import crypto from 'crypto';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import fs from 'fs/promises';
import { MicrocksSyncStore } from './MicrocksSyncStore';
import {
  type NormalizedMockConfig,
  type OpenApiSource,
  getOpenApiSourceFromEntity,
  isHttpUrl,
  normalizeNonEmptyString,
  parseLocationRef,
  parseMocksConfig,
  resolveMicrocksYamlTarget,
  resolveRelativeTarget,
  toBaseDirFromLocation,
} from './MicrocksConfigUtils';
import { fetchWithTimeout } from './HttpUtils';

const ANNOTATION = 'bcgov/microcks-config-ref';

type OpenApiServer = {
  url: string;
  description?: string;
};

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function sha256Buffer(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function getUrlMetadataBestEffort(
  url: string,
): Promise<{ etag?: string; lastModified?: string; contentLength?: string }> {
  try {
    const res = await fetchWithTimeout(
      url,
      { method: 'HEAD' },
      5000,
      `HEAD ${url}`,
    );

    if (!res.ok) return {};

    return {
      etag: res.headers.get('etag') ?? undefined,
      lastModified: res.headers.get('last-modified') ?? undefined,
      contentLength: res.headers.get('content-length') ?? undefined,
    };
  } catch {
    return {};
  }
}

function isObjectRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function encodeMicrocksPathSegment(value: string): string {
  return encodeURIComponent(value).replace(/%20/g, '+');
}

function buildMicrocksMockServerUrl(
  microcksBaseUrl: string,
  serviceName: string,
  versionId: string,
): string {
  const base = microcksBaseUrl.replace(/\/+$/, '');
  const encodedServiceName = encodeMicrocksPathSegment(serviceName);
  const encodedVersionId = encodeMicrocksPathSegment(versionId);
  return `${base}/rest/${encodedServiceName}/${encodedVersionId}`;
}

function appendMicrocksServersToOpenApi(
  definitionText: string,
  servers: OpenApiServer[],
): string | undefined {
  let doc: unknown;

  try {
    doc = parseYaml(definitionText);
  } catch {
    return undefined;
  }

  if (!isObjectRecord(doc)) {
    return undefined;
  }

  if (!('openapi' in doc) && !('swagger' in doc)) {
    return undefined;
  }

  const existingServersRaw = Array.isArray(doc.servers) ? doc.servers : [];
  const existingServers: OpenApiServer[] = existingServersRaw.filter(
    s => isObjectRecord(s) && typeof s.url === 'string',
  ) as OpenApiServer[];

  const existingUrls = new Set(existingServers.map(s => s.url.trim()));
  const newServers = servers.filter(s => !existingUrls.has(s.url.trim()));

  if (newServers.length > 0) {
    doc.servers = [...existingServersRaw, ...newServers];
  }

  return stringifyYaml(doc);
}

async function markAllMocksMissingForEntity(
  store: MicrocksSyncStore | undefined,
  entityRef: string,
): Promise<void> {
  if (!store) {
    return;
  }

  await store.markMissingMocksForEntity(entityRef, []);
}

export class CsitMicrocksProcessor implements CatalogProcessor {
  private readonly processorName = 'csit-microcks-processor';

  constructor(
    private readonly logger: LoggerService,
    private readonly reader: UrlReaderService,
    private readonly store?: MicrocksSyncStore,
    private readonly microcksBaseUrl?: string,
  ) {}

  getProcessorName(): string {
    return this.processorName;
  }

  async postProcessEntity(
    entity: Entity,
    location: LocationSpec,
    _emit: CatalogProcessorEmit,
  ): Promise<Entity> {
    const start = Date.now();
    const entityRef = stringifyEntityRef(entity);

    this.logger.info(
      `[csit-microcks-processor] enter ${this.processorName}.postProcessEntity entity=${entityRef}`,
    );

    try {
      const rawRef = entity.metadata.annotations?.[ANNOTATION];

      if (!rawRef) {
        await markAllMocksMissingForEntity(this.store, entityRef);

        await this.store?.recordEvent({
          entityRef,
          eventType: 'processor.annotation_missing',
          message: `Entity does not define ${ANNOTATION}; scheduled deletes for any previously tracked mocks`,
          details: {
            annotation: ANNOTATION,
          },
        });

        this.logger.debug(
          `[csit-microcks-processor] skip entity=${entityRef} reason=no ${ANNOTATION}`,
        );
        return entity;
      }

      await this.store?.recordEvent({
        entityRef,
        eventType: 'processor.annotation_found',
        message: `Processing Microcks configuration for entity`,
        details: {
          annotation: ANNOTATION,
          annotationValue: rawRef,
        },
      });

      let microcksTarget: string;

      try {
        const locRef = parseLocationRef(rawRef);
        const base = toBaseDirFromLocation(location);
        microcksTarget = resolveMicrocksYamlTarget(base, locRef);
      } catch (e) {
        await markAllMocksMissingForEntity(this.store, entityRef);

        const err = e instanceof Error ? e : new Error(String(e));

        await this.store?.recordEvent({
          entityRef,
          eventType: 'processor.annotation_invalid',
          level: 'warn',
          message: err.message,
          details: {
            annotation: ANNOTATION,
            annotationValue: rawRef,
          },
        });

        this.logger.warn(
          `[csit-microcks-processor] skip entity=${entityRef} reason=invalid ${ANNOTATION} value="${rawRef}" error="${err.message}"`,
        );
        return entity;
      }

      let text: string;
      try {
        if (isHttpUrl(microcksTarget)) {
          const response = await this.reader.readUrl(microcksTarget);
          const contents = await response.buffer();
          text = contents.toString('utf8');
        } else {
          text = await fs.readFile(microcksTarget, 'utf8');
        }
      } catch (e) {
        await markAllMocksMissingForEntity(this.store, entityRef);

        const err = e instanceof Error ? e : new Error(String(e));

        await this.store?.recordEvent({
          entityRef,
          eventType: 'processor.config_load_failed',
          level: 'warn',
          message: `microcks.yaml not found or unreadable`,
          details: {
            annotationValue: rawRef,
            resolvedTarget: microcksTarget,
            error: err.message,
          },
        });

        this.logger.warn(
          `[csit-microcks-processor] microcks.yaml not found/readable for entity=${entityRef} ref="${rawRef}" resolved="${microcksTarget}" error="${err.message}"`,
        );
        return entity;
      }

      await this.store?.recordEvent({
        entityRef,
        eventType: 'processor.config_loaded',
        message: `Loaded microcks.yaml`,
        details: {
          source: microcksTarget,
          bytes: Buffer.byteLength(text, 'utf8'),
        },
      });

      let mocks: NormalizedMockConfig[];
      try {
        mocks = parseMocksConfig(text);
      } catch (e) {
        await markAllMocksMissingForEntity(this.store, entityRef);

        const err = e instanceof Error ? e : new Error(String(e));

        await this.store?.recordEvent({
          entityRef,
          eventType: 'processor.config_invalid',
          level: 'warn',
          message: err.message,
          details: {
            source: microcksTarget,
          },
        });

        this.logger.warn(
          `[csit-microcks-processor] invalid microcks.yaml yaml for entity=${entityRef} source=${microcksTarget} error="${err.message}"`,
        );
        return entity;
      }

      await this.store?.recordEvent({
        entityRef,
        eventType: 'processor.config_parsed',
        message: `Parsed microcks.yaml`,
        details: {
          source: microcksTarget,
          mockCount: mocks.length,
          mockIds: mocks.map(m => m.mockId),
          swaggerEnabledMockIds: mocks
            .filter(m => m.includeInSwagger)
            .map(m => m.mockId),
          swaggerDisabledMockIds: mocks
            .filter(m => !m.includeInSwagger)
            .map(m => m.mockId),
        },
      });

      const microcksYamlHash = sha256(text);
      const entityHash = `bk-${sha256(entityRef).slice(0, 16)}`;

      const entityName = normalizeNonEmptyString(entity.metadata?.name);
      const definitionText =
        typeof entity.spec?.definition === 'string'
          ? entity.spec.definition
          : undefined;

      if (entityName && definitionText && this.microcksBaseUrl) {
        const swaggerMocks = mocks.filter(mock => mock.includeInSwagger);

        const servers: OpenApiServer[] = swaggerMocks.map(mock => {
          const versionId = `${entityHash}-${mock.mockId}`;
          const mockServerUrl = buildMicrocksMockServerUrl(
            this.microcksBaseUrl!,
            entityName,
            versionId,
          );

          return {
            url: mockServerUrl,
            description: `Mocked Service (${mock.mockId}) with fixed responses for testing and development purposes`,
          };
        });

        const updatedDefinitionText = appendMicrocksServersToOpenApi(
          definitionText,
          servers,
        );

        if (updatedDefinitionText) {
          entity = {
            ...entity,
            spec: {
              ...entity.spec,
              definition: updatedDefinitionText,
            },
          };

          await this.store?.recordEvent({
            entityRef,
            eventType: 'processor.openapi_servers_injected',
            message: `Injected Microcks mock servers into OpenAPI definition`,
            details: {
              serverCount: servers.length,
              mockIds: swaggerMocks.map(m => m.mockId),
              excludedMockIds: mocks
                .filter(m => !m.includeInSwagger)
                .map(m => m.mockId),
            },
          });

          for (const mock of swaggerMocks) {
            const versionId = `${entityHash}-${mock.mockId}`;
            const mockServerUrl = buildMicrocksMockServerUrl(
              this.microcksBaseUrl,
              entityName,
              versionId,
            );

            this.logger.info(
              `[csit-microcks-processor] appended mock server entity=${entityRef} mockId=${mock.mockId} url="${mockServerUrl}"`,
            );
          }
        } else {
          await this.store?.recordEvent({
            entityRef,
            eventType: 'processor.openapi_injection_skipped',
            message: `Skipped OpenAPI mock server injection`,
            details: {
              reason: 'definition-not-openapi-or-not-parseable',
            },
          });

          this.logger.debug(
            `[csit-microcks-processor] skipped mock server injection entity=${entityRef} reason=definition-not-openapi-or-not-parseable`,
          );
        }
      } else if (!this.microcksBaseUrl) {
        await this.store?.recordEvent({
          entityRef,
          eventType: 'processor.openapi_injection_skipped',
          message: `Skipped OpenAPI mock server injection`,
          details: {
            reason: 'no-microcks-base-url-configured',
          },
        });

        this.logger.debug(
          `[csit-microcks-processor] skipped mock server injection entity=${entityRef} reason=no microcks base url configured`,
        );
      }

      if (this.store) {
        try {
          const activeMockIds = mocks.map(mock => mock.mockId);
          await this.store.markMissingMocksForEntity(entityRef, activeMockIds);

          await this.store.recordEvent({
            entityRef,
            eventType: 'processor.active_mocks_computed',
            message: `Computed active mocks for entity`,
            details: {
              activeMockIds,
              source: microcksTarget,
            },
          });

          for (const mock of mocks) {
            const fingerprintParts: string[] = [];
            fingerprintParts.push(`entityRef=${entityRef}`);
            fingerprintParts.push(`microcksTarget=${microcksTarget}`);
            fingerprintParts.push(`microcksYamlHash=${microcksYamlHash}`);
            fingerprintParts.push(`mockId=${mock.mockId}`);

            for (const a of mock.artifacts) {
              const resolved = resolveRelativeTarget(microcksTarget, a.path);

              if (isHttpUrl(resolved)) {
                const meta = await getUrlMetadataBestEffort(resolved);
                fingerprintParts.push(
                  `artifact:${a.kind}:${resolved}:etag=${meta.etag ?? ''}:lm=${meta.lastModified ?? ''}:len=${meta.contentLength ?? ''}`,
                );
              } else {
                try {
                  const st = await fs.stat(resolved);
                  fingerprintParts.push(
                    `artifact:${a.kind}:${resolved}:size=${st.size}:mtimeMs=${st.mtimeMs}`,
                  );
                } catch (e) {
                  const err = e instanceof Error ? e : new Error(String(e));
                  fingerprintParts.push(
                    `artifact:${a.kind}:${resolved}:statError=${err.message}`,
                  );
                }
              }
            }

            let openapiSource: OpenApiSource | undefined;

            if (mock.openapiOverridePath) {
              const resolved = resolveRelativeTarget(
                microcksTarget,
                mock.openapiOverridePath,
              );
              openapiSource = { kind: 'url', url: resolved };
            } else {
              openapiSource = getOpenApiSourceFromEntity(entity);
            }

            if (openapiSource) {
              if (openapiSource.kind === 'inline') {
                const openapiInlineHash = sha256(openapiSource.text);

                this.logger.info(
                  `[csit-microcks-processor] openapi fingerprint source entity=${entityRef} mockId=${mock.mockId} kind=inline hash=${openapiInlineHash} length=${openapiSource.text.length}`,
                );

                fingerprintParts.push(`openapi:inlineHash=${openapiInlineHash}`);
              } else {
                const target = openapiSource.url;

                this.logger.info(
                  `[csit-microcks-processor] openapi fingerprint source entity=${entityRef} mockId=${mock.mockId} kind=url target="${target}"`,
                );

                if (isHttpUrl(target)) {
                  const meta = await getUrlMetadataBestEffort(target);
                  if (!meta.etag && !meta.lastModified && !meta.contentLength) {
                    try {
                      const resp = await this.reader.readUrl(target);
                      const buf = await resp.buffer();
                      const openapiUrlHash = sha256Buffer(buf);

                      this.logger.info(
                        `[csit-microcks-processor] openapi fingerprint url fallback entity=${entityRef} mockId=${mock.mockId} target="${target}" hash=${openapiUrlHash} bytes=${buf.length}`,
                      );

                      fingerprintParts.push(
                        `openapi:urlHash=${openapiUrlHash}:url=${target}`,
                      );
                    } catch (e) {
                      const err = e instanceof Error ? e : new Error(String(e));
                      this.logger.info(
                        `[csit-microcks-processor] openapi fingerprint url read error entity=${entityRef} mockId=${mock.mockId} target="${target}" error="${err.message}"`,
                      );
                      fingerprintParts.push(
                        `openapi:urlError=${err.message}:url=${target}`,
                      );
                    }
                  } else {
                    this.logger.info(
                      `[csit-microcks-processor] openapi fingerprint url metadata entity=${entityRef} mockId=${mock.mockId} target="${target}" etag="${meta.etag ?? ''}" lastModified="${meta.lastModified ?? ''}" contentLength="${meta.contentLength ?? ''}"`,
                    );

                    fingerprintParts.push(
                      `openapi:urlMeta:url=${target}:etag=${meta.etag ?? ''}:lm=${meta.lastModified ?? ''}:len=${meta.contentLength ?? ''}`,
                    );
                  }
                } else {
                  try {
                    const st = await fs.stat(target);
                    this.logger.info(
                      `[csit-microcks-processor] openapi fingerprint file metadata entity=${entityRef} mockId=${mock.mockId} path="${target}" size=${st.size} mtimeMs=${st.mtimeMs}`,
                    );
                    fingerprintParts.push(
                      `openapi:file:${target}:size=${st.size}:mtimeMs=${st.mtimeMs}`,
                    );
                  } catch (e) {
                    const err = e instanceof Error ? e : new Error(String(e));
                    this.logger.info(
                      `[csit-microcks-processor] openapi fingerprint file stat error entity=${entityRef} mockId=${mock.mockId} path="${target}" error="${err.message}"`,
                    );
                    fingerprintParts.push(
                      `openapi:fileError=${err.message}:path=${target}`,
                    );
                  }
                }
              }
            } else {
              this.logger.info(
                `[csit-microcks-processor] openapi fingerprint source entity=${entityRef} mockId=${mock.mockId} kind=none`,
              );
              fingerprintParts.push('openapi:none');
            }

            const fingerprintHash = sha256(fingerprintParts.join('\n'));
            const versionId = `${entityHash}-${mock.mockId}`;

            const changed = await this.store.upsertSyncRecord({
              entityRef,
              mockId: mock.mockId,
              versionId,
              fingerprintHash,
            });

            if (!changed) {
              await this.store.recordEvent({
                entityRef,
                mockId: mock.mockId,
                eventType: 'processor.mock_unchanged',
                message: `Sync inputs unchanged for mock '${mock.mockId}'`,
                details: {
                  fingerprintHash,
                  versionId,
                  source: microcksTarget,
                  includeInSwagger: mock.includeInSwagger,
                },
              });

              this.logger.info(
                `[csit-microcks-processor] unchanged sync inputs entity=${entityRef} mockId=${mock.mockId} fingerprint=${fingerprintHash} (skipping)`,
              );
              continue;
            }

            await this.store.recordEvent({
              entityRef,
              mockId: mock.mockId,
              eventType: 'processor.mock_scheduled',
              message: `Scheduled reconcile for mock '${mock.mockId}'`,
              details: {
                fingerprintHash,
                versionId,
                source: microcksTarget,
                artifactCount: mock.artifacts.length,
                openapiOverridePath: mock.openapiOverridePath ?? null,
                includeInSwagger: mock.includeInSwagger,
              },
            });

            this.logger.info(
              `[csit-microcks-processor] changed sync inputs entity=${entityRef} mockId=${mock.mockId} microcksSource=${microcksTarget} fingerprint=${fingerprintHash}`,
            );
          }
        } catch (e) {
          const err = e instanceof Error ? e : new Error(String(e));

          await this.store.recordEvent({
            entityRef,
            eventType: 'processor.persistence_failed',
            level: 'warn',
            message: err.message,
            details: {
              source: microcksTarget,
            },
          });

          this.logger.warn(
            `[csit-microcks-processor] failed to persist status entity=${entityRef} error="${err.message}" (continuing)`,
          );
        }
      }

      return entity;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));

      await this.store?.recordEvent({
        entityRef,
        eventType: 'processor.error',
        level: 'error',
        message: err.message,
      });

      this.logger.error(
        `[csit-microcks-processor] error entity=${entityRef} message=${err.message}`,
      );
      if (err.stack) this.logger.debug(err.stack);
      return entity;
    } finally {
      const ms = Date.now() - start;

      await this.store?.recordEvent({
        entityRef,
        eventType: 'processor.finished',
        message: `Processor finished for entity`,
        details: {
          durationMs: ms,
        },
      });

      this.logger.info(
        `[csit-microcks-processor] exit ${this.processorName}.postProcessEntity entity=${entityRef} durationMs=${ms}`,
      );
    }
  }
}