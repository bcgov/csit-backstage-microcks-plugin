import {
  coreServices,
  createBackendModule,
  resolvePackagePath,
} from '@backstage/backend-plugin-api';
import { CatalogClient } from '@backstage/catalog-client';
import { catalogProcessingExtensionPoint } from '@backstage/plugin-catalog-node';
import { CsitMicrocksProcessor } from './CsitMicrocksProcessor';
import { getMicrocksServerConfig } from './MicrocksConfig';
import { MicrocksSyncStore } from './MicrocksSyncStore';
import { MicrocksSyncWorker } from './MicrocksSyncWorker';

export const csitMicrocksCatalogModule = createBackendModule({
  pluginId: 'catalog',
  moduleId: 'csit-microcks',
  register(reg) {
    reg.registerInit({
      deps: {
        catalog: catalogProcessingExtensionPoint,
        logger: coreServices.logger,
        urlReader: coreServices.urlReader,
        database: coreServices.database,
        lifecycle: coreServices.lifecycle,
        discovery: coreServices.discovery,
        auth: coreServices.auth,
        config: coreServices.rootConfig,
      },
      async init({
        catalog,
        logger,
        urlReader,
        database,
        lifecycle,
        discovery,
        auth,
        config,
      }) {
        const client = await database.getClient();

        const migrationsDir = resolvePackagePath(
          '@bcgov/csit-microcks-backend-backstage-plugin',
          'migrations',
        );

        if (!database.migrations?.skip) {
          logger.info(
            `csit-microcks: running database migrations from ${migrationsDir}`,
          );

          await client.migrate.latest({
            directory: migrationsDir,
            tableName: 'knex_migrations_csit_microcks',
          });
        } else {
          logger.info(`csit-microcks: database migrations skipped by config`);
        }

        const store = new MicrocksSyncStore(client);

        const catalogClient = new CatalogClient({
          discoveryApi: discovery,
          fetchApi: {
            fetch: async (input: any, init: any = {}) => {
              const { token } = await auth.getPluginRequestToken({
                onBehalfOf: await auth.getOwnServiceCredentials(),
                targetPluginId: 'catalog',
              });

              const headers = new Headers(init.headers ?? {});
              headers.set('Authorization', `Bearer ${token}`);

              return fetch(input, { ...init, headers });
            },
          },
        });

        const worker = new MicrocksSyncWorker(
          store,
          logger,
          catalogClient,
          urlReader,
          config,
        );

        lifecycle.addStartupHook(async () => {
          worker.start();
        });
        lifecycle.addShutdownHook(async () => worker.stop());

        const microcksBaseUrl = getMicrocksServerConfig(config).baseUrl;

        logger.info('[csit-microcks] registering catalog processor');
        catalog.addProcessor(
          new CsitMicrocksProcessor(
            logger,
            urlReader,
            store,
            microcksBaseUrl,
          ),
        );
      },
    });
  },
});