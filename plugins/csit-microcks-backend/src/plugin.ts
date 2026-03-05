import { createBackendPlugin } from '@backstage/backend-plugin-api';

export const csitMicrocksPlugin = createBackendPlugin({
  pluginId: 'csit-microcks',
  register() {
    // intentionally empty (for now)
  },
});