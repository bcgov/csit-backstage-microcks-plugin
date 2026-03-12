import type { LoggerService } from '@backstage/backend-plugin-api';
import fs from 'fs/promises';
import type { FetchWithTimeout } from './HttpUtils';

type GetMicrocksBaseUrl = () => string;

export class MicrocksUnauthorizedError extends Error {
  readonly url: string;

  constructor(url: string, message?: string) {
    super(
      message ??
        [
          '[csit-microcks-client] Microcks returned 401 Unauthorized',
          `url: ${url}`,
          '',
          'This likely means the token is invalid, expired, or no longer accepted.',
        ].join('\n'),
    );
    this.name = 'MicrocksUnauthorizedError';
    this.url = url;
  }
}

export type MicrocksServiceSummary = {
  id?: string;
  name?: string;
  version?: string;
  [key: string]: unknown;
};

export class MicrocksClient {
  constructor(
    private readonly logger: LoggerService,
    private readonly getBaseUrl: GetMicrocksBaseUrl,
    private readonly fetchWithTimeout: FetchWithTimeout,
  ) {}

  private isHttpUrl(value: string): boolean {
    return value.startsWith('http://') || value.startsWith('https://');
  }

  private async readErrorBody(resp: Response): Promise<string> {
    return (await resp.text().catch(() => '')).slice(0, 2000);
  }

  private async request(
    pathOrUrl: string,
    token: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const baseUrl = this.getBaseUrl();
    const url = this.isHttpUrl(pathOrUrl)
      ? pathOrUrl
      : `${baseUrl.replace(/\/$/, '')}/${pathOrUrl.replace(/^\//, '')}`;

    const method = init.method ?? 'GET';

    const headers = new Headers(init.headers ?? {});
    headers.set('Authorization', `Bearer ${token}`);
    headers.set('Accept', 'application/json');

    this.logger.info(
      `[csit-microcks-client] request start method=${method} url="${url}"`,
    );

    let resp: Response;
    try {
      resp = await this.fetchWithTimeout(
        url,
        {
          ...init,
          headers,
        },
        10_000,
        `${method} ${url}`,
      );
    } catch (error) {
      this.logger.error(
        `[csit-microcks-client] request failed method=${method} url="${url}" error=${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }

    this.logger.info(
      `[csit-microcks-client] request complete method=${method} url="${url}" status=${resp.status} statusText="${resp.statusText}"`,
    );

    if (resp.status === 401) {
      this.logger.error(
        `[csit-microcks-client] unauthorized method=${method} url="${url}"`,
      );
      throw new MicrocksUnauthorizedError(url);
    }

    return resp;
  }

  async listServices(
    page = 0,
    size = 20,
    token: string,
  ): Promise<MicrocksServiceSummary[]> {
    const resp = await this.request(
      `/api/services?page=${page}&size=${size}`,
      token,
      { method: 'GET' },
    );

    if (!resp.ok) {
      const body = await this.readErrorBody(resp);
      this.logger.error(
        `[csit-microcks-client] list services failed page=${page} size=${size} HTTP ${resp.status} ${resp.statusText} body=${body}`,
      );
      throw new Error(
        `Failed to list Microcks services page=${page} size=${size} HTTP ${resp.status} ${resp.statusText} body=${body}`,
      );
    }

    const payload: any = await resp.json();

    if (Array.isArray(payload)) {
      return payload as MicrocksServiceSummary[];
    }

    if (Array.isArray(payload?.services)) {
      return payload.services as MicrocksServiceSummary[];
    }

    if (Array.isArray(payload?.content)) {
      return payload.content as MicrocksServiceSummary[];
    }

    this.logger.error(
      '[csit-microcks-client] unexpected response shape from GET /api/services',
    );
    throw new Error('Unexpected response shape from GET /api/services');
  }

  async deleteService(serviceId: string, token: string): Promise<void> {
    const encodedServiceId = encodeURIComponent(serviceId);

    const resp = await this.request(
      `/api/services/${encodedServiceId}`,
      token,
      { method: 'DELETE' },
    );

    if (resp.status === 404) {
      this.logger.info(
        `[csit-microcks-client] delete skipped id="${serviceId}" reason=not-found`,
      );
      return;
    }

    if (!resp.ok) {
      const body = await this.readErrorBody(resp);
      this.logger.error(
        `[csit-microcks-client] delete failed id="${serviceId}" HTTP ${resp.status} ${resp.statusText} body=${body}`,
      );
      throw new Error(
        `Failed to delete Microcks service id="${serviceId}" HTTP ${resp.status} ${resp.statusText} body=${body}`,
      );
    }

    this.logger.info(
      `[csit-microcks-client] deleted stale Microcks service id="${serviceId}"`,
    );
  }

  async uploadArtifact(
    filename: string,
    filePath: string,
    token: string,
    mainArtifact: boolean,
  ): Promise<void> {
    const content = await fs.readFile(filePath);
    const form = new FormData();
    const blob = new Blob([content], { type: 'application/yaml' });
    form.set('file', blob, filename);

    const resp = await this.request(
      `/api/artifact/upload?mainArtifact=${mainArtifact ? 'true' : 'false'}`,
      token,
      {
        method: 'POST',
        body: form,
      },
    );

    if (!resp.ok) {
      const body = await this.readErrorBody(resp);
      this.logger.error(
        `[csit-microcks-client] upload failed filename="${filename}" path="${filePath}" mainArtifact=${mainArtifact} HTTP ${resp.status} ${resp.statusText} body=${body}`,
      );
      throw new Error(
        `Failed to upload Microcks artifact filename="${filename}" path="${filePath}" mainArtifact=${mainArtifact} HTTP ${resp.status} ${resp.statusText} body=${body}`,
      );
    }

    this.logger.info(
      `[csit-microcks-client] uploaded artifact filename="${filename}" path="${filePath}" mainArtifact=${mainArtifact}`,
    );
  }

  private isMetadataArtifact(filename: string): boolean {
    return /metadata/i.test(filename);
  }

  async uploadArtifacts(
    params: {
      token: string;
      mainArtifact: { filename: string; path: string };
      secondaryArtifacts?: Array<{ filename: string; path: string }>;
    },
  ): Promise<void> {
    const { token, mainArtifact, secondaryArtifacts = [] } = params;

    const metadataArtifacts = secondaryArtifacts.filter(artifact =>
      this.isMetadataArtifact(artifact.filename),
    );
    const otherSecondaryArtifacts = secondaryArtifacts.filter(
      artifact => !this.isMetadataArtifact(artifact.filename),
    );

    if (metadataArtifacts.length > 0) {
      this.logger.info(
        `[csit-microcks-client] metadata-first upload enabled metadataArtifacts=${metadataArtifacts
          .map(a => `"${a.filename}"`)
          .join(',')}`,
      );
    }

    for (const artifact of metadataArtifacts) {
      await this.uploadArtifact(
        artifact.filename,
        artifact.path,
        token,
        false,
      );
    }

    await this.uploadArtifact(
      mainArtifact.filename,
      mainArtifact.path,
      token,
      true,
    );

    for (const artifact of otherSecondaryArtifacts) {
      await this.uploadArtifact(
        artifact.filename,
        artifact.path,
        token,
        false,
      );
    }
  }
}