import type { MicrocksServiceSummary } from './MicrocksClient';

export function getEntityVersionPrefix(versionId: string, mockId: string): string {
  const suffix = `-${mockId}`;
  return versionId.endsWith(suffix)
    ? versionId.slice(0, -suffix.length)
    : versionId;
}

type ReconciledService = {
  id: string;
  name: string;
  version: string;
};

export class MicrocksReconciler {
  reconcileOwnedServices(params: {
    services: MicrocksServiceSummary[];
    desiredName: string;
    desiredVersion: string;
    desiredVersions: string[];
    mockId: string;
  }): {
    action: 'create' | 'update';
    owned: ReconciledService[];
    exactMatches: ReconciledService[];
    toDelete: ReconciledService[];
    entityVersionPrefix: string;
  } {
    const {
      services,
      desiredName,
      desiredVersion,
      desiredVersions,
      mockId,
    } = params;

    const entityVersionPrefix = getEntityVersionPrefix(desiredVersion, mockId);

    const normalized = services
      .map(s => ({
        id: typeof s.id === 'string' ? s.id.trim() : '',
        name: typeof s.name === 'string' ? s.name.trim() : '',
        version: typeof s.version === 'string' ? s.version.trim() : '',
      }))
      .filter(s => s.id && s.name && s.version);

    const owned = normalized.filter(s =>
      s.version.startsWith(`${entityVersionPrefix}-`),
    );

    const exactMatches = owned.filter(
      s => s.name === desiredName && s.version === desiredVersion,
    );

    if (exactMatches.length > 1) {
      throw new Error(
        `Expected at most one owned Microcks service match for name="${desiredName}" version="${desiredVersion}" but found ${exactMatches.length}`,
      );
    }

    const desiredVersionSet = new Set(
      desiredVersions.map(v => v.trim()).filter(Boolean),
    );

    const toDelete = owned.filter(s => !desiredVersionSet.has(s.version));

    return {
      action: exactMatches.length === 1 ? 'update' : 'create',
      owned,
      exactMatches,
      toDelete,
      entityVersionPrefix,
    };
  }
}