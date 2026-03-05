import type { LoggerService } from '@backstage/backend-plugin-api';
import fs from 'fs/promises';

type FetchWithTimeout = (
  url: string,
  init: RequestInit,
  timeoutMs: number,
  label: string,
) => Promise<Response>;

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

  private async request(
    pathOrUrl: string,
    token: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const baseUrl = this.getBaseUrl();
    const url = this.isHttpUrl(pathOrUrl)
      ? pathOrUrl
      : `${baseUrl.replace(/\/$/, '')}/${pathOrUrl.replace(/^\//, '')}`;

    const headers = new Headers(init.headers ?? {});
    headers.set('Authorization', `Bearer ${token}`);
    headers.set('Accept', 'application/json');

    const resp = await this.fetchWithTimeout(
      url,
      {
        ...init,
        headers,
      },
      10_000,
      `${init.method ?? 'GET'} ${url}`,
    );

    if (resp.status === 401) {
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
      const body = await resp.text().catch(() => '');
      throw new Error(
        `Failed to list Microcks services page=${page} size=${size} HTTP ${resp.status} ${resp.statusText} body=${body.slice(
          0,
          500,
        )}`,
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
      const body = await resp.text().catch(() => '');
      throw new Error(
        `Failed to delete Microcks service id="${serviceId}" HTTP ${resp.status} ${resp.statusText} body=${body.slice(
          0,
          500,
        )}`,
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
      const body = await resp.text().catch(() => '');
      throw new Error(
        `Failed to upload Microcks artifact filename="${filename}" path="${filePath}" mainArtifact=${mainArtifact} HTTP ${resp.status} ${resp.statusText} body=${body.slice(
          0,
          1000,
        )}`,
      );
    }

    this.logger.info(
      `[csit-microcks-client] uploaded artifact filename="${filename}" path="${filePath}" mainArtifact=${mainArtifact}`,
    );
  }

  async uploadArtifacts(
    params: {
      token: string;
      mainArtifact: { filename: string; path: string };
      secondaryArtifacts?: Array<{ filename: string; path: string }>;
    },
  ): Promise<void> {
    const { token, mainArtifact, secondaryArtifacts = [] } = params;

    await this.uploadArtifact(
      mainArtifact.filename,
      mainArtifact.path,
      token,
      true,
    );

    for (const artifact of secondaryArtifacts) {
      await this.uploadArtifact(
        artifact.filename,
        artifact.path,
        token,
        false,
      );
    }
  }
}