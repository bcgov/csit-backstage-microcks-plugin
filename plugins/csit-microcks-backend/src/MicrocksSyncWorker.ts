import type { LoggerService, UrlReaderService } from '@backstage/backend-plugin-api';
import type { Config } from '@backstage/config';
import { CatalogClient } from '@backstage/catalog-client';
import { MicrocksSyncStore } from './MicrocksSyncStore';
import {
  MicrocksClient,
  MicrocksUnauthorizedError,
} from './MicrocksClient';
import {
  getMicrocksServerConfig,
  hasMicrocksConfig,
} from './MicrocksConfig';
import {
  MicrocksTokenAcquisitionError,
  MicrocksTokenProvider,
} from './MicrocksTokenProvider';
import { MicrocksDesiredStateLoader } from './MicrocksDesiredStateLoader';
import { MicrocksSyncJobRunner } from './MicrocksSyncJobRunner';

function computeBackoffSeconds(attempt: number): number {
  const base = 15;
  const secs = base * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(600, Math.floor(secs));
}

type ClaimedSyncRecord = NonNullable<
  Awaited<ReturnType<MicrocksSyncStore['claimNextPending']>>
>;

export class MicrocksSyncWorker {
  private timer?: NodeJS.Timeout;
  private running = false;
  private loggedMissingConfig = false;
  private globalBackoffUntilMs = 0;
  private globalBackoffAttempts = 0;

  private readonly microcksClient: MicrocksClient;
  private readonly tokenProvider: MicrocksTokenProvider;
  private readonly desiredStateLoader: MicrocksDesiredStateLoader;
  private readonly jobRunner: MicrocksSyncJobRunner;

  private readonly leaseMs = 60_000;

  constructor(
    private readonly store: MicrocksSyncStore,
    private readonly logger: LoggerService,
    private readonly catalog: CatalogClient,
    private readonly urlReader: UrlReaderService,
    private readonly config: Config,
    private readonly intervalMs = 10000,
  ) {
    this.microcksClient = new MicrocksClient(
      this.logger,
      () => getMicrocksServerConfig(this.config).baseUrl,
      async (url, init, timeoutMs, label) => {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), timeoutMs);

        try {
          return await fetch(url, { ...init, signal: controller.signal });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          throw new Error(`${label} failed: ${msg}`);
        } finally {
          clearTimeout(t);
        }
      },
    );

    this.tokenProvider = new MicrocksTokenProvider(this.logger, this.config);

    this.desiredStateLoader = new MicrocksDesiredStateLoader(
      this.logger,
      this.catalog,
      this.urlReader,
    );

    this.jobRunner = new MicrocksSyncJobRunner(
      this.store,
      this.logger,
      this.microcksClient,
      this.desiredStateLoader,
    );
  }

  start() {
    if (this.timer) return;

    this.logger.info('[csit-microcks-sync-worker] sync worker started');
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      this.logger.info('[csit-microcks-sync-worker] sync worker stopped');
    }
  }

  private logMissingMicrocksConfigOnce() {
    if (this.loggedMissingConfig) return;
    this.loggedMissingConfig = true;

    this.logger.error(
      `[csit-microcks-sync-worker] Missing Microcks configuration. Expected app-config key ` +
        `"csitMicrocks". ` +
        `Processor will continue queuing jobs; worker will not claim jobs until config is provided.`,
    );
  }

  private enterGlobalBackoff(reason: string, details: string) {
    this.globalBackoffAttempts += 1;
    const backoffSeconds = computeBackoffSeconds(this.globalBackoffAttempts);
    this.globalBackoffUntilMs = Date.now() + backoffSeconds * 1000;

    this.logger.error(
      [
        '============================================================',
        '[csit-microcks-sync-worker] GLOBAL BACKOFF ACTIVATED',
        `reason: ${reason}`,
        `attempt: ${this.globalBackoffAttempts}`,
        `backoffSeconds: ${backoffSeconds}`,
        `backoffUntil: ${new Date(this.globalBackoffUntilMs).toISOString()}`,
        '',
        details,
        '============================================================',
      ].join('\n'),
    );
  }

  private clearGlobalBackoffOnSuccess() {
    if (this.globalBackoffAttempts === 0 && this.globalBackoffUntilMs === 0) return;
    this.globalBackoffAttempts = 0;
    this.globalBackoffUntilMs = 0;
    this.logger.info('[csit-microcks-sync-worker] global backoff cleared');
  }

  private shouldSkipForGlobalBackoff(): boolean {
    return Date.now() < this.globalBackoffUntilMs;
  }

  private async handleClaimedRecord(
    record: ClaimedSyncRecord,
  ) {
    const token = await this.tokenProvider.getAccessToken();

    this.clearGlobalBackoffOnSuccess();

    await this.jobRunner.execute(record, token);
  }

  private async handleClaimedRecordError(
    record: ClaimedSyncRecord,
    e: unknown,
  ) {
    if (e instanceof MicrocksTokenAcquisitionError) {
      this.enterGlobalBackoff('token_acquisition_failed', e.message);

      await this.store.recordEvent({
        entityRef: record.entity_ref,
        mockId: record.mock_id,
        syncStatusId: record.id,
        eventType: 'worker.global_backoff',
        level: 'error',
        message: e.message,
        details: {
          reason: 'token_acquisition_failed',
          globalBackoffAttempts: this.globalBackoffAttempts,
          globalBackoffUntil: new Date(this.globalBackoffUntilMs).toISOString(),
        },
      });

      this.logger.info(
        `[csit-microcks-sync-worker] releasing lease after global failure entity=${record.entity_ref} mock=${record.mock_id} version=${record.microcks_version_id}`,
      );

      await this.store.clearLease(record.id, e.message);
      return;
    }

    if (e instanceof MicrocksUnauthorizedError) {
      this.tokenProvider.clearCache();
      this.enterGlobalBackoff('microcks_401', e.message);

      await this.store.recordEvent({
        entityRef: record.entity_ref,
        mockId: record.mock_id,
        syncStatusId: record.id,
        eventType: 'worker.global_backoff',
        level: 'error',
        message: e.message,
        details: {
          reason: 'microcks_401',
          globalBackoffAttempts: this.globalBackoffAttempts,
          globalBackoffUntil: new Date(this.globalBackoffUntilMs).toISOString(),
        },
      });

      this.logger.info(
        `[csit-microcks-sync-worker] releasing lease after global failure entity=${record.entity_ref} mock=${record.mock_id} version=${record.microcks_version_id}`,
      );

      await this.store.clearLease(record.id, e.message);
      return;
    }

    const msg = e instanceof Error ? e.message : String(e);

    await this.store.recordEvent({
      entityRef: record.entity_ref,
      mockId: record.mock_id,
      syncStatusId: record.id,
      eventType: 'worker.failed',
      level: 'error',
      message: msg,
      details: {
        desiredAction: record.desired_action,
        microcksVersionId: record.microcks_version_id,
      },
    });

    await this.store.markError(record.id, msg);
  }

  private async tick() {
    if (this.running) {
      this.logger.debug(
        '[csit-microcks-sync-worker] tick skipped because previous tick is still running',
      );
      return;
    }

    this.running = true;

    try {
      this.logger.debug('[csit-microcks-sync-worker] tick start');

      if (!hasMicrocksConfig(this.config)) {
        this.logMissingMicrocksConfigOnce();
        return;
      }

      if (this.shouldSkipForGlobalBackoff()) {
        this.logger.info(
          `[csit-microcks-sync-worker] skipping tick due to GLOBAL backoff until ${new Date(
            this.globalBackoffUntilMs,
          ).toISOString()}`,
        );
        return;
      }

      const record = await this.store.claimNextPending(this.leaseMs);

      if (!record) {
        this.logger.debug('[csit-microcks-sync-worker] no eligible sync records');
        return;
      }

      this.logger.info(
        `[csit-microcks-sync-worker] claimed sync entity=${record.entity_ref} mock=${record.mock_id} version=${record.microcks_version_id} desiredAction=${record.desired_action} leaseExpiresAt=${record.lease_expires_at instanceof Date ? record.lease_expires_at.toISOString() : String(record.lease_expires_at)}`,
      );

      try {
        await this.handleClaimedRecord(record);
      } catch (e) {
        await this.handleClaimedRecordError(record, e);
      }
    } catch (err) {
      this.logger.error(`[csit-microcks-sync-worker] worker error: ${err}`);
    } finally {
      this.running = false;
      this.logger.debug('[csit-microcks-sync-worker] tick end');
    }
  }
}