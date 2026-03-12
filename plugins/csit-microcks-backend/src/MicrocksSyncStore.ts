import { Knex } from 'knex';

type EventLevel = 'debug' | 'info' | 'warn' | 'error';

export class MicrocksSyncStore {
  constructor(private readonly db: Knex) {}

  private truncateMessage(message: string, max = 4000): string {
    return message.length > max ? `${message.slice(0, max)}…` : message;
  }

  private normalizeErrorMessage(message: string): string {
    return this.truncateMessage(message.trim() || 'Unknown error');
  }

  async upsertSyncRecord(input: {
    entityRef: string;
    mockId: string;
    versionId: string;
    fingerprintHash: string;
  }): Promise<boolean> {
    return this.db.transaction(async trx => {
      const now = new Date();

      const existing = await trx('csit_microcks_sync_status')
        .where({
          entity_ref: input.entityRef,
          mock_id: input.mockId,
        })
        .first(['id', 'fingerprint_hash', 'desired_action']);

      if (
        existing &&
        existing.fingerprint_hash === input.fingerprintHash &&
        existing.desired_action === 'reconcile'
      ) {
        return false;
      }

      await trx('csit_microcks_sync_status')
        .insert({
          entity_ref: input.entityRef,
          mock_id: input.mockId,
          desired_action: 'reconcile',
          microcks_version_id: input.versionId,
          fingerprint_hash: input.fingerprintHash,
          status: 'pending',
          last_run_at: now,

          attempt_count: 0,
          next_attempt_at: null,
          last_attempt_at: null,
          last_error: null,

          leased_at: null,
          lease_expires_at: null,
        })
        .onConflict(['entity_ref', 'mock_id'])
        .merge({
          desired_action: 'reconcile',
          microcks_version_id: input.versionId,
          fingerprint_hash: input.fingerprintHash,
          status: 'pending',
          last_run_at: now,

          attempt_count: 0,
          next_attempt_at: null,
          last_attempt_at: null,
          last_error: null,

          leased_at: null,
          lease_expires_at: null,
        });

      const syncRow = await trx('csit_microcks_sync_status')
        .where({
          entity_ref: input.entityRef,
          mock_id: input.mockId,
        })
        .first(['id']);

      await this.insertEvent(trx, {
        entityRef: input.entityRef,
        mockId: input.mockId,
        syncStatusId: syncRow?.id,
        eventType: 'sync.reconcile_scheduled',
        level: 'info',
        message: existing
          ? `Scheduled reconcile for mock '${input.mockId}'`
          : `Created reconcile row for mock '${input.mockId}'`,
        details: {
          versionId: input.versionId,
          fingerprintHash: input.fingerprintHash,
          previousFingerprintHash: existing?.fingerprint_hash ?? null,
          previousDesiredAction: existing?.desired_action ?? null,
        },
      });

      return true;
    });
  }

  async markMissingMocksForEntity(entityRef: string, activeMockIds: string[]) {
    await this.db.transaction(async trx => {
      const rows = await trx('csit_microcks_sync_status')
        .where({ entity_ref: entityRef })
        .select('*');

      for (const row of rows) {
        if (activeMockIds.includes(row.mock_id)) {
          continue;
        }

        if (row.desired_action === 'delete' && row.status === 'completed') {
          continue;
        }

        await trx('csit_microcks_sync_status')
          .where({ id: row.id })
          .update({
            desired_action: 'delete',
            status: 'pending',

            attempt_count: 0,
            next_attempt_at: null,
            last_attempt_at: null,
            last_error: null,

            leased_at: null,
            lease_expires_at: null,
          });

        await this.insertEvent(trx, {
          entityRef,
          mockId: row.mock_id,
          syncStatusId: row.id,
          eventType: 'sync.delete_scheduled',
          level: 'info',
          message: `Scheduled delete for missing mock '${row.mock_id}'`,
          details: {
            activeMockIds,
            previousDesiredAction: row.desired_action,
            previousStatus: row.status,
          },
        });
      }
    });
  }

  async listPending(limit = 20) {
    const now = new Date();

    return this.db('csit_microcks_sync_status')
      .where({ status: 'pending' })
      .andWhere(qb =>
        qb.whereNull('next_attempt_at').orWhere('next_attempt_at', '<=', now),
      )
      .andWhere(qb =>
        qb.whereNull('lease_expires_at').orWhere('lease_expires_at', '<=', now),
      )
      .orderBy('id', 'asc')
      .limit(limit)
      .select('*');
  }

  async claimNextPending(leaseMs: number) {
    return this.db.transaction(async trx => {
      const now = new Date();
      const leaseExpiresAt = new Date(now.getTime() + leaseMs);

      const row = await trx('csit_microcks_sync_status')
        .where({ status: 'pending' })
        .andWhere(qb =>
          qb.whereNull('next_attempt_at').orWhere('next_attempt_at', '<=', now),
        )
        .andWhere(qb =>
          qb.whereNull('lease_expires_at').orWhere('lease_expires_at', '<=', now),
        )
        .orderBy('id', 'asc')
        .first('*');

      if (!row) {
        return undefined;
      }

      const updated = await trx('csit_microcks_sync_status')
        .where({ id: row.id, status: 'pending' })
        .andWhere(qb =>
          qb.whereNull('lease_expires_at').orWhere('lease_expires_at', '<=', now),
        )
        .update({
          leased_at: now,
          lease_expires_at: leaseExpiresAt,
          last_run_at: now,
          last_attempt_at: now,
        });

      if (updated !== 1) {
        return undefined;
      }

      await this.insertEvent(trx, {
        entityRef: row.entity_ref,
        mockId: row.mock_id,
        syncStatusId: row.id,
        eventType: 'sync.claimed',
        level: 'info',
        message: `Claimed ${row.desired_action} job for mock '${row.mock_id}'`,
        details: {
          leaseMs,
          leasedAt: now.toISOString(),
          leaseExpiresAt: leaseExpiresAt.toISOString(),
          status: row.status,
          desiredAction: row.desired_action,
          attemptCount: row.attempt_count,
        },
      });

      return {
        ...row,
        leased_at: now,
        lease_expires_at: leaseExpiresAt,
        last_run_at: now,
        last_attempt_at: now,
      };
    });
  }

  async markCompleted(id: number, message?: string) {
    await this.db.transaction(async trx => {
      const row = await trx('csit_microcks_sync_status')
        .where({ id })
        .first('*');

      if (!row) {
        return;
      }

      const completedAt = new Date();
      const normalizedMessage = message ? this.normalizeErrorMessage(message) : null;

      await trx('csit_microcks_sync_status')
        .where({ id })
        .update({
          status: 'completed',
          last_success_at: completedAt,
          last_message: normalizedMessage,
          next_attempt_at: null,
          last_error: null,
          leased_at: null,
          lease_expires_at: null,
        });

      await this.insertEvent(trx, {
        entityRef: row.entity_ref,
        mockId: row.mock_id,
        syncStatusId: row.id,
        eventType:
          row.desired_action === 'delete'
            ? 'sync.delete_completed'
            : 'sync.reconcile_completed',
        level: 'info',
        message:
          normalizedMessage ??
          (row.desired_action === 'delete'
            ? `Completed delete for mock '${row.mock_id}'`
            : `Completed reconcile for mock '${row.mock_id}'`),
        details: {
          desiredAction: row.desired_action,
          completedAt: completedAt.toISOString(),
          attemptCount: row.attempt_count,
          microcksVersionId: row.microcks_version_id,
        },
      });
    });
  }

  async markError(id: number, message: string) {
    await this.db.transaction(async trx => {
      const row = await trx('csit_microcks_sync_status')
        .where({ id })
        .first('*');

      if (!row) {
        return;
      }

      const normalizedMessage = this.normalizeErrorMessage(message);

      await trx('csit_microcks_sync_status')
        .where({ id })
        .update({
          status: 'error',
          last_message: normalizedMessage,
          last_error: normalizedMessage,
          last_attempt_at: new Date(),
          leased_at: null,
          lease_expires_at: null,
        });

      await this.insertEvent(trx, {
        entityRef: row.entity_ref,
        mockId: row.mock_id,
        syncStatusId: row.id,
        eventType: 'sync.error',
        level: 'error',
        message: normalizedMessage,
        details: {
          desiredAction: row.desired_action,
          attemptCount: row.attempt_count,
          microcksVersionId: row.microcks_version_id,
        },
      });
    });
  }

  private computeBackoffSeconds(attemptCount: number): number {
    const attempt = Math.max(1, attemptCount);
    const seconds = 10 * Math.pow(2, attempt - 1);
    return Math.min(seconds, 15 * 60);
  }

  async markRetryableError(id: number, message: string): Promise<{
    nextAttemptCount: number;
    backoffSeconds: number;
    nextAttemptAt: string;
  } | undefined> {
    return this.db.transaction(async trx => {
      const row = await trx('csit_microcks_sync_status')
        .where({ id })
        .first('*');

      if (!row) {
        return undefined;
      }

      const prev = Number(row.attempt_count ?? 0);
      const nextAttemptCount = prev + 1;

      const backoffSeconds = this.computeBackoffSeconds(nextAttemptCount);
      const nextAttemptAt = new Date(Date.now() + backoffSeconds * 1000);
      const normalizedMessage = this.normalizeErrorMessage(message);

      await trx('csit_microcks_sync_status')
        .where({ id })
        .update({
          status: 'pending',
          attempt_count: nextAttemptCount,
          next_attempt_at: nextAttemptAt,
          last_message: normalizedMessage,
          last_error: normalizedMessage,
          last_attempt_at: new Date(),
          leased_at: null,
          lease_expires_at: null,
        });

      await this.insertEvent(trx, {
        entityRef: row.entity_ref,
        mockId: row.mock_id,
        syncStatusId: row.id,
        eventType: 'sync.retry_scheduled',
        level: 'warn',
        message: normalizedMessage,
        details: {
          desiredAction: row.desired_action,
          previousAttemptCount: prev,
          nextAttemptCount,
          backoffSeconds,
          nextAttemptAt: nextAttemptAt.toISOString(),
          microcksVersionId: row.microcks_version_id,
        },
      });

      return {
        nextAttemptCount,
        backoffSeconds,
        nextAttemptAt: nextAttemptAt.toISOString(),
      };
    });
  }

  async clearLease(id: number, message?: string) {
    await this.db.transaction(async trx => {
      const row = await trx('csit_microcks_sync_status')
        .where({ id })
        .first('*');

      if (!row) {
        return;
      }

      const normalizedMessage = message ? this.normalizeErrorMessage(message) : null;

      await trx('csit_microcks_sync_status')
        .where({ id })
        .update({
          leased_at: null,
          lease_expires_at: null,
          last_message: normalizedMessage ?? row.last_message ?? null,
          last_error: normalizedMessage ?? row.last_error ?? null,
        });

      await this.insertEvent(trx, {
        entityRef: row.entity_ref,
        mockId: row.mock_id,
        syncStatusId: row.id,
        eventType: 'sync.lease_cleared',
        level: normalizedMessage ? 'error' : 'info',
        message: normalizedMessage ?? `Cleared lease for mock '${row.mock_id}'`,
        details: {
          desiredAction: row.desired_action,
          attemptCount: row.attempt_count,
          microcksVersionId: row.microcks_version_id,
        },
      });
    });
  }

  async recordAttemptMessage(id: number, message: string) {
    await this.db.transaction(async trx => {
      const row = await trx('csit_microcks_sync_status')
        .where({ id })
        .first('*');

      if (!row) {
        return;
      }

      const normalizedMessage = this.normalizeErrorMessage(message);

      await trx('csit_microcks_sync_status')
        .where({ id })
        .update({
          last_message: normalizedMessage,
          last_attempt_at: new Date(),
        });

      await this.insertEvent(trx, {
        entityRef: row.entity_ref,
        mockId: row.mock_id,
        syncStatusId: row.id,
        eventType: 'sync.progress',
        level: 'info',
        message: normalizedMessage,
        details: {
          desiredAction: row.desired_action,
          attemptCount: row.attempt_count,
          microcksVersionId: row.microcks_version_id,
        },
      });
    });
  }

  async recordEvent(input: {
    entityRef: string;
    mockId?: string | null;
    syncStatusId?: number | null;
    eventType: string;
    level?: EventLevel;
    message: string;
    details?: unknown;
  }) {
    await this.writeEvent(this.db, input);
  }

  private async insertEvent(
    trx: Knex.Transaction,
    input: {
      entityRef: string;
      mockId?: string | null;
      syncStatusId?: number | null;
      eventType: string;
      level?: EventLevel;
      message: string;
      details?: unknown;
    },
  ) {
    await this.writeEvent(trx, input);
  }

  private async writeEvent(
    db: Knex | Knex.Transaction,
    input: {
      entityRef: string;
      mockId?: string | null;
      syncStatusId?: number | null;
      eventType: string;
      level?: EventLevel;
      message: string;
      details?: unknown;
    },
  ) {
    await db('csit_microcks_sync_events').insert({
      entity_ref: input.entityRef,
      mock_id: input.mockId ?? null,
      sync_status_id: input.syncStatusId ?? null,
      event_type: input.eventType,
      level: input.level ?? 'info',
      message: this.normalizeErrorMessage(input.message),
      details_json:
        input.details === undefined ? null : JSON.stringify(input.details),
      created_at: new Date(),
    });
  }
}