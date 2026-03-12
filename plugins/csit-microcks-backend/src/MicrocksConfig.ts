import type { Config } from '@backstage/config';

export type KeycloakAuthConfig = {
  type: 'keycloak';
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
};

export type MicrocksServerAuthConfig =
  | KeycloakAuthConfig
  | { type: string; [key: string]: unknown };

export type MicrocksServerConfig = {
  baseUrl: string;
  auth: MicrocksServerAuthConfig;
};

export function hasMicrocksConfig(config: Config): boolean {
  try {
    return config.has('csitMicrocks.server') || config.has('csitMicrocks.baseUrl');
  } catch {
    return false;
  }
}

export function getMicrocksServerConfig(config: Config): MicrocksServerConfig {
  if (config.has('csitMicrocks.baseUrl')) {
    const root = config.getConfig('csitMicrocks');
    const baseUrl = root.getString('baseUrl');
    const authCfg = root.getConfig('auth');
    const type = authCfg.getString('type');

    if (type !== 'keycloak') {
      return { baseUrl, auth: { type } };
    }

    return {
      baseUrl,
      auth: {
        type: 'keycloak',
        issuerUrl: authCfg.getString('issuerUrl'),
        clientId: authCfg.getString('clientId'),
        clientSecret: authCfg.getString('clientSecret'),
      },
    };
  }

  const server = config.getConfig('csitMicrocks').getConfig('server');
  const baseUrl = server.getString('baseUrl');
  const authCfg = server.getConfig('auth');
  const type = authCfg.getString('type');

  if (type !== 'keycloak') {
    return { baseUrl, auth: { type } };
  }

  return {
    baseUrl,
    auth: {
      type: 'keycloak',
      issuerUrl: authCfg.getString('issuerUrl'),
      clientId: authCfg.getString('clientId'),
      clientSecret: authCfg.getString('clientSecret'),
    },
  };
}

export function isKeycloakAuth(
  auth: MicrocksServerAuthConfig,
): auth is KeycloakAuthConfig {
  const a = auth as Partial<KeycloakAuthConfig>;
  return (
    a?.type === 'keycloak' &&
    typeof a.issuerUrl === 'string' &&
    typeof a.clientId === 'string' &&
    typeof a.clientSecret === 'string'
  );
}