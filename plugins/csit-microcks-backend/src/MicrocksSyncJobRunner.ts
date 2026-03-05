import type { LoggerService } from '@backstage/backend-plugin-api';
import { MicrocksSyncStore } from './MicrocksSyncStore';
import { MicrocksClient } from './MicrocksClient';
import {
  getEntityVersionPrefix,
  MicrocksReconciler,
} from './MicrocksReconciler';
import { MicrocksDesiredStateLoader } from './MicrocksDesiredStateLoader';
import { MicrocksArtifactIdentityStamper } from './MicrocksArtifactIdentityStamper';

type ClaimedSyncRecord = NonNullable<
  Awaited<ReturnType<MicrocksSyncStore['claimNextPending']>>
>;

type DesiredState = Awaited<ReturnType<MicrocksDesiredStateLoader['load']>>;

export class MicrocksSyncJobRunner {
  private readonly reconciler = new MicrocksReconciler();
  private readonly artifactIdentityStamper = new MicrocksArtifactIdentityStamper();

  constructor(
    private readonly store: MicrocksSyncStore,
    private readonly logger: LoggerService,
    private readonly microcksClient: MicrocksClient,
    private readonly desiredStateLoader: MicrocksDesiredStateLoader,
  ) {}

  async execute(record: ClaimedSyncRecord, token: string) {
    if (record.desired_action === 'delete') {
      await this.handleDeleteAction(record, token);
      return;
    }

    await this.processReconcileAction(record, token);
  }

  private async scanOwnedServices(
    token: string,
    desiredVersion: string,
    mockId: string,
  ) {
    const size = 100;
    const entityVersionPrefix = getEntityVersionPrefix(desiredVersion, mockId);
    const ownedServices: Array<{ id?: string; name: string; version: string }> =
      [];
    let page = 0;

    for (;;) {
      const items = await this.microcksClient.listServices(page, size, token);

      for (const s of items) {
        const name = typeof s.name === 'string' ? s.name.trim() : '';
        const version = typeof s.version === 'string' ? s.version.trim() : '';
        const id = typeof s.id === 'string' ? s.id.trim() : undefined;

        if (!name || !version) {
          continue;
        }

        if (!version.startsWith(`${entityVersionPrefix}-`)) {
          continue;
        }

        ownedServices.push({ id, name, version });
      }

      if (items.length < size) {
        break;
      }

      page += 1;
    }

    return ownedServices;
  }

  private async scanOwnedServicesForMock(
    token: string,
    desiredVersion: string,
    mockId: string,
  ) {
    const ownedServices = await this.scanOwnedServices(
      token,
      desiredVersion,
      mockId,
    );

    return ownedServices.filter(s => s.version.endsWith(`-${mockId}`));
  }

  private async uploadDesiredArtifacts(
    token: string,
    entityRef: string,
    desired: DesiredState,
    desiredVersion: string,
    mode: 'create' | 'update',
  ) {
    await this.artifactIdentityStamper.stampArtifactIdentity({
      entityName: desired.entityName,
      desiredVersion,
      mainArtifact: desired.mainArtifact,
      secondaryArtifacts: desired.secondaryArtifacts,
    });

    this.logger.info(
      `[csit-microcks-sync-job-runner] uploading ${mode} artifacts entity=${entityRef} mockId=${desired.mockId} mainArtifact="${desired.mainArtifact.filename}" secondaryArtifacts=${desired.secondaryArtifacts.length}`,
    );

    await this.microcksClient.uploadArtifacts({
      token,
      mainArtifact: desired.mainArtifact,
      secondaryArtifacts: desired.secondaryArtifacts,
    });
  }

  private async deleteExactServiceIfPresent(
    token: string,
    desiredVersion: string,
    mockId: string,
  ) {
    const ownedServices = await this.scanOwnedServices(
      token,
      desiredVersion,
      mockId,
    );
    const exactMatches = ownedServices.filter(s => s.version === desiredVersion);

    for (const svc of exactMatches) {
      if (!svc.id) {
        throw new Error(
          `Cannot delete Microcks service without id name="${svc.name}" version="${svc.version}"`,
        );
      }

      this.logger.info(
        `[csit-microcks-sync-job-runner] deleting Microcks service id="${svc.id}" name="${svc.name}" version="${svc.version}"`,
      );

      await this.microcksClient.deleteService(svc.id, token);
    }

    return exactMatches.length;
  }

  private async deleteOwnedServicesForMock(
    token: string,
    entityRef: string,
    mockId: string,
    desiredVersion: string,
    syncStatusId: number,
    reason: string,
  ) {
    const ownedServices = await this.scanOwnedServicesForMock(
      token,
      desiredVersion,
      mockId,
    );

    for (const svc of ownedServices) {
      if (!svc.id) {
        throw new Error(
          `Cannot delete Microcks service without id name="${svc.name}" version="${svc.version}"`,
        );
      }

      await this.store.recordEvent({
        entityRef,
        mockId,
        syncStatusId,
        eventType: 'worker.service_delete_started',
        level: 'error',
        message: `Deleting Microcks service '${svc.name}' after reconcile failure for mock '${mockId}'`,
        details: {
          serviceId: svc.id,
          serviceName: svc.name,
          serviceVersion: svc.version,
          reason,
        },
      });

      this.logger.info(
        `[csit-microcks-sync-job-runner] deleting Microcks service after reconcile failure id="${svc.id}" name="${svc.name}" version="${svc.version}" reason=${reason}`,
      );

      await this.microcksClient.deleteService(svc.id, token);
    }

    return ownedServices.length;
  }

  private async handleDeleteAction(
    record: ClaimedSyncRecord,
    token: string,
  ) {
    await this.store.recordEvent({
      entityRef: record.entity_ref,
      mockId: record.mock_id,
      syncStatusId: record.id,
      eventType: 'worker.delete_started',
      message: `Starting delete for mock '${record.mock_id}'`,
      details: {
        desiredAction: record.desired_action,
        microcksVersionId: record.microcks_version_id,
      },
    });

    const deletedCount = await this.deleteExactServiceIfPresent(
      token,
      record.microcks_version_id,
      record.mock_id,
    );

    this.logger.info(
      `[csit-microcks-sync-job-runner] delete result entity=${record.entity_ref} mockId=${record.mock_id} desiredVersion="${record.microcks_version_id}" deleted=${deletedCount}`,
    );

    await this.store.recordEvent({
      entityRef: record.entity_ref,
      mockId: record.mock_id,
      syncStatusId: record.id,
      eventType: 'worker.delete_finished',
      message: `Finished delete for mock '${record.mock_id}'`,
      details: {
        desiredAction: record.desired_action,
        microcksVersionId: record.microcks_version_id,
        deletedCount,
      },
    });

    await this.store.markCompleted(
      record.id,
      `deleted exactMatches=${deletedCount}`,
    );
  }

  private async loadDesiredStateOrCleanup(
    record: ClaimedSyncRecord,
    token: string,
  ): Promise<DesiredState> {
    try {
      return await this.desiredStateLoader.load(record.entity_ref, record.mock_id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);

      await this.store.recordEvent({
        entityRef: record.entity_ref,
        mockId: record.mock_id,
        syncStatusId: record.id,
        eventType: 'worker.desired_state_load_failed',
        level: 'error',
        message: msg,
        details: {
          desiredAction: record.desired_action,
          microcksVersionId: record.microcks_version_id,
          stage: 'desired_state_load',
        },
      });

      const deletedCount = await this.deleteOwnedServicesForMock(
        token,
        record.entity_ref,
        record.mock_id,
        record.microcks_version_id,
        record.id,
        'desired_state_load_failed',
      );

      await this.store.recordEvent({
        entityRef: record.entity_ref,
        mockId: record.mock_id,
        syncStatusId: record.id,
        eventType: 'worker.invalid_reconcile_cleanup_finished',
        level: 'error',
        message: `Removed owned Microcks services for invalid reconcile of mock '${record.mock_id}'`,
        details: {
          desiredAction: record.desired_action,
          microcksVersionId: record.microcks_version_id,
          deletedCount,
          stage: 'desired_state_load',
          reason: 'desired_state_load_failed',
        },
      });

      throw e;
    }
  }

  private async recordArtifactUploadStarted(
    record: ClaimedSyncRecord,
    desired: DesiredState,
    mode: 'create' | 'update',
  ) {
    await this.store.recordEvent({
      entityRef: record.entity_ref,
      mockId: desired.mockId,
      syncStatusId: record.id,
      eventType: 'worker.artifact_upload_started',
      message: `Uploading ${mode} artifacts for mock '${desired.mockId}'`,
      details: {
        mode,
        desiredApiName: desired.desiredApiName,
        microcksVersionId: record.microcks_version_id,
        mainArtifactFilename: desired.mainArtifact.filename,
        secondaryArtifactFilenames: desired.secondaryArtifacts.map(
          a => a.filename,
        ),
      },
    });
  }

  private async recordArtifactUploadFinished(
    record: ClaimedSyncRecord,
    desired: DesiredState,
    mode: 'create' | 'update',
  ) {
    await this.store.recordEvent({
      entityRef: record.entity_ref,
      mockId: desired.mockId,
      syncStatusId: record.id,
      eventType: 'worker.artifact_upload_finished',
      message: `Uploaded ${mode} artifacts for mock '${desired.mockId}'`,
      details: {
        mode,
        desiredApiName: desired.desiredApiName,
        microcksVersionId: record.microcks_version_id,
        mainArtifactFilename: desired.mainArtifact.filename,
        secondaryArtifactFilenames: desired.secondaryArtifacts.map(
          a => a.filename,
        ),
      },
    });
  }

  private async processReconcileAction(
    record: ClaimedSyncRecord,
    token: string,
  ) {
    const desired = await this.loadDesiredStateOrCleanup(record, token);

    const desiredVersions = desired.allMockIds.map(
      mockId =>
        `${getEntityVersionPrefix(record.microcks_version_id, desired.mockId)}-${mockId}`,
    );

    await this.store.recordEvent({
      entityRef: record.entity_ref,
      mockId: desired.mockId,
      syncStatusId: record.id,
      eventType: 'worker.reconcile_started',
      message: `Starting reconcile for mock '${desired.mockId}'`,
      details: {
        desiredAction: record.desired_action,
        microcksVersionId: record.microcks_version_id,
        desiredApiName: desired.desiredApiName,
        desiredVersions,
        mainArtifactFilename: desired.mainArtifact.filename,
        secondaryArtifactCount: desired.secondaryArtifacts.length,
      },
    });

    const ownedServices = await this.scanOwnedServices(
      token,
      record.microcks_version_id,
      desired.mockId,
    );

    const reconciliation = this.reconciler.reconcileOwnedServices({
      services: ownedServices,
      desiredName: desired.desiredApiName,
      desiredVersion: record.microcks_version_id,
      desiredVersions,
      mockId: desired.mockId,
    });

    this.logger.info(
      `[csit-microcks-sync-job-runner] reconcile entity-owned services desiredName="${desired.desiredApiName}" desiredVersion="${record.microcks_version_id}" desiredVersions=${desiredVersions.join(',')} owned=${reconciliation.owned.length} delete=${reconciliation.toDelete.length} exactMatches=${reconciliation.exactMatches.length}`,
    );

    await this.store.recordEvent({
      entityRef: record.entity_ref,
      mockId: desired.mockId,
      syncStatusId: record.id,
      eventType: 'worker.reconcile_plan',
      message: `Planned reconcile for mock '${desired.mockId}'`,
      details: {
        desiredApiName: desired.desiredApiName,
        microcksVersionId: record.microcks_version_id,
        desiredVersions,
        action: reconciliation.action,
        ownedCount: reconciliation.owned.length,
        deleteCount: reconciliation.toDelete.length,
        exactMatchCount: reconciliation.exactMatches.length,
        ownedServices: reconciliation.owned.map(s => ({
          id: s.id,
          name: s.name,
          version: s.version,
        })),
        toDelete: reconciliation.toDelete.map(s => ({
          id: s.id,
          name: s.name,
          version: s.version,
        })),
        exactMatches: reconciliation.exactMatches.map(s => ({
          id: s.id,
          name: s.name,
          version: s.version,
        })),
      },
    });

    for (const svc of reconciliation.toDelete) {
      await this.store.recordEvent({
        entityRef: record.entity_ref,
        mockId: desired.mockId,
        syncStatusId: record.id,
        eventType: 'worker.service_delete_started',
        message: `Deleting stale Microcks service '${svc.name}'`,
        details: {
          serviceId: svc.id,
          serviceName: svc.name,
          serviceVersion: svc.version,
          reason: 'stale_owned_service',
        },
      });

      await this.microcksClient.deleteService(svc.id, token);
    }

    if (reconciliation.action === 'update') {
      const exactMatch = reconciliation.exactMatches[0];

      if (!exactMatch) {
        throw new Error(
          `Expected exact Microcks service match for update name="${desired.desiredApiName}" version="${record.microcks_version_id}"`,
        );
      }

      this.logger.info(
        `[csit-microcks-sync-job-runner] deleting existing Microcks service before update id="${exactMatch.id}" name="${exactMatch.name}" version="${exactMatch.version}"`,
      );

      await this.store.recordEvent({
        entityRef: record.entity_ref,
        mockId: desired.mockId,
        syncStatusId: record.id,
        eventType: 'worker.update_replace_started',
        message: `Deleting existing exact-match service before update for mock '${desired.mockId}'`,
        details: {
          serviceId: exactMatch.id,
          serviceName: exactMatch.name,
          serviceVersion: exactMatch.version,
          desiredApiName: desired.desiredApiName,
          microcksVersionId: record.microcks_version_id,
        },
      });

      await this.microcksClient.deleteService(exactMatch.id, token);

      await this.recordArtifactUploadStarted(record, desired, 'update');

      await this.uploadDesiredArtifacts(
        token,
        record.entity_ref,
        desired,
        record.microcks_version_id,
        'update',
      );

      await this.recordArtifactUploadFinished(record, desired, 'update');
    }

    if (reconciliation.action === 'create') {
      await this.recordArtifactUploadStarted(record, desired, 'create');

      await this.uploadDesiredArtifacts(
        token,
        record.entity_ref,
        desired,
        record.microcks_version_id,
        'create',
      );

      await this.recordArtifactUploadFinished(record, desired, 'create');
    }

    this.logger.info(
      `[csit-microcks-sync-job-runner] reconcile result entity=${record.entity_ref} mockId=${desired.mockId} desiredName="${desired.desiredApiName}" desiredVersion="${record.microcks_version_id}" action=${reconciliation.action}`,
    );

    await this.store.recordEvent({
      entityRef: record.entity_ref,
      mockId: desired.mockId,
      syncStatusId: record.id,
      eventType: 'worker.reconcile_finished',
      message: `Finished reconcile for mock '${desired.mockId}'`,
      details: {
        action: reconciliation.action,
        desiredApiName: desired.desiredApiName,
        microcksVersionId: record.microcks_version_id,
      },
    });

    await this.store.markCompleted(
      record.id,
      `reconciled action=${reconciliation.action}`,
    );
  }
}