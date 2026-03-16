import type { LoggerService } from '@backstage/backend-plugin-api';
import type { Config } from '@backstage/config';
import type { FetchWithTimeout } from './HttpUtils';
import {
  getMicrocksServerConfig,
  isKeycloakAuth,
} from './MicrocksConfig';

type CachedAccessToken = {
  accessToken: string;
  expiresAt: number;
};

type OidcDiscoveryDoc = {
  token_endpoint?: string;
};

type ClientCredentialsTokenResponse = {
  access_token?: string;
  expires_in?: number;
  expires_at?: number;
  token_type?: string;
  scope?: string;
};

export class MicrocksTokenAcquisitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MicrocksTokenAcquisitionError';
  }
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export class MicrocksTokenProvider {
  private tokenCache?: CachedAccessToken;

  constructor(
    private readonly logger: LoggerService,
    private readonly config: Config,
    private readonly fetchWithTimeout: FetchWithTimeout,
  ) {}

  clearCache() {
    this.tokenCache = undefined;
  }

  async getAccessToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);

    if (this.tokenCache && this.tokenCache.expiresAt - 30 > now) {
      return this.tokenCache.accessToken;
    }

    const cfg = getMicrocksServerConfig(this.config);

    if (!isKeycloakAuth(cfg.auth)) {
      throw new Error(`Unsupported auth type for csitMicrocks.auth.type: ${cfg.auth.type}`);
    }

    const issuerUrl = cfg.auth.issuerUrl;
    const issuerHost = (() => {
      try {
        return new URL(issuerUrl).host;
      } catch {
        return issuerUrl;
      }
    })();

    try {
      this.logger.debug(
        `[csit-microcks-token-provider] requesting token via OIDC discovery issuer=${issuerUrl} clientId=${cfg.auth.clientId}`,
      );

      const discoveryUrl = issuerUrl.replace(/\/$/, '') + '/.well-known/openid-configuration';
      const discoveryResp = await this.fetchWithTimeout(
        discoveryUrl,
        { method: 'GET', headers: { Accept: 'application/json' } },
        10_000,
        `OIDC discovery GET ${discoveryUrl}`,
      );

      if (!discoveryResp.ok) {
        const body = await discoveryResp.text().catch(() => '');
        throw new Error(
          `OIDC discovery HTTP ${discoveryResp.status} ${discoveryResp.statusText} body=${body.slice(
            0,
            500,
          )}`,
        );
      }

      const discovery = (await discoveryResp.json()) as OidcDiscoveryDoc;
      const tokenEndpoint = discovery.token_endpoint;
      if (!tokenEndpoint || typeof tokenEndpoint !== 'string') {
        throw new Error('OIDC discovery missing token_endpoint');
      }

      const form = new URLSearchParams();
      form.set('grant_type', 'client_credentials');
      form.set('client_id', cfg.auth.clientId);
      form.set('client_secret', cfg.auth.clientSecret);

      const tokenResp = await this.fetchWithTimeout(
        tokenEndpoint,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: form.toString(),
        },
        10_000,
        `Token POST ${tokenEndpoint}`,
      );

      if (!tokenResp.ok) {
        const body = await tokenResp.text().catch(() => '');
        throw new Error(
          `Token endpoint HTTP ${tokenResp.status} ${tokenResp.statusText} body=${body.slice(0, 800)}`,
        );
      }

      const tokenSet = (await tokenResp.json()) as ClientCredentialsTokenResponse;
      const accessToken = tokenSet.access_token;

      if (!accessToken) {
        throw new Error('Keycloak token response missing access_token');
      }

      const expiresAt =
        typeof tokenSet.expires_at === 'number'
          ? tokenSet.expires_at
          : now + (typeof tokenSet.expires_in === 'number' ? tokenSet.expires_in : 300);

      this.tokenCache = { accessToken, expiresAt };

      this.logger.debug(
        `[csit-microcks-token-provider] obtained token issuer=${issuerUrl} clientId=${cfg.auth.clientId} expiresAt=${expiresAt}`,
      );

      return accessToken;
    } catch (e) {
      const msg = errorMessage(e);

      throw new MicrocksTokenAcquisitionError(
        [
          '[csit-microcks-token-provider] FAILED TO OBTAIN KEYCLOAK TOKEN',
          `issuerUrl: ${issuerUrl}`,
          `issuerHost: ${issuerHost}`,
          `clientId: ${cfg.auth.clientId}`,
          '',
          'Common causes:',
          '  - outbound network/TLS/proxy issues from the Backstage backend runtime',
          '  - wrong issuerUrl (some Keycloak deployments drop the /auth prefix)',
          '  - Keycloak client misconfigured (service accounts disabled, wrong secret, missing grant)',
          '',
          `Error: ${msg}`,
        ].join('\n'),
      );
    }
  }
}