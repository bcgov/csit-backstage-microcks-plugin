/* eslint-disable no-undef */

/**
 * Tabled for Microcks sync jobs.
 * Works on SQLite (better-sqlite3) and Postgres.
 */
exports.up = async function up(knex) {
  const hasStatus = await knex.schema.hasTable('csit_microcks_sync_status');
  if (!hasStatus) {
    await knex.schema.createTable('csit_microcks_sync_status', table => {
      table.increments('id').primary();

      // Identity
      table.string('entity_ref', 512).notNullable();
      table.string('mock_id', 128).notNullable();

      // Desired action for the worker
      // 'reconcile' | 'delete'
      table.string('desired_action', 32).notNullable().defaultTo('reconcile');

      // Derived deterministic Microcks version id ("bk-<entityHash>-<mockId>")
      table.string('microcks_version_id', 64).notNullable();

      // Persisted processor fingerprint used to detect changes across restarts
      table.string('fingerprint_hash', 64).notNullable();

      // Status: 'pending' | 'completed' | 'error'
      table.string('status', 32).notNullable();
      table.text('last_message').nullable();

      table.timestamp('last_run_at').nullable();
      table.timestamp('last_success_at').nullable();

      // Retry / scheduling fields
      table.integer('attempt_count').notNullable().defaultTo(0);
      table.timestamp('next_attempt_at').nullable();
      table.timestamp('last_attempt_at').nullable();
      table.text('last_error').nullable();

      // Lease-based claim fields
      table.timestamp('leased_at').nullable();
      table.timestamp('lease_expires_at').nullable();

      // Unique per entity+mock (single Microcks instance design)
      table.unique(['entity_ref', 'mock_id'], {
        indexName: 'csit_microcks_sync_status_identity_uq',
      });

      table.index(['entity_ref'], 'csit_microcks_sync_status_entity_ix');

      // Helps claim/list eligible pending rows
      table.index(
        ['status', 'next_attempt_at', 'lease_expires_at'],
        'csit_microcks_sync_status_pending_sched_ix',
      );
    });
  }

  const hasEvents = await knex.schema.hasTable('csit_microcks_sync_events');
  if (hasEvents) return;

  await knex.schema.createTable('csit_microcks_sync_events', table => {
    table.increments('id').primary();

    // Entity-level events have mock_id = null.
    table.string('entity_ref', 512).notNullable();
    table.string('mock_id', 128).nullable();

    // Optional link to the sync status row active at the time of the event.
    table
      .integer('sync_status_id')
      .nullable()
      .references('id')
      .inTable('csit_microcks_sync_status')
      .onDelete('SET NULL');

    // Logical event classification and severity.
    table.string('event_type', 128).notNullable();
    table.string('level', 32).notNullable().defaultTo('info');

    // Human-readable summary plus high-detail structured payload.
    table.text('message').notNullable();
    table.text('details_json').nullable();

    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    table.index(['entity_ref'], 'csit_microcks_sync_events_entity_ix');
    table.index(
      ['entity_ref', 'mock_id'],
      'csit_microcks_sync_events_entity_mock_ix',
    );
    table.index(['sync_status_id'], 'csit_microcks_sync_events_status_ix');
    table.index(['event_type'], 'csit_microcks_sync_events_type_ix');
    table.index(['created_at'], 'csit_microcks_sync_events_created_at_ix');
  });
};

exports.down = async function down(knex) {
  const hasEvents = await knex.schema.hasTable('csit_microcks_sync_events');
  if (hasEvents) {
    await knex.schema.dropTable('csit_microcks_sync_events');
  }

  const hasStatus = await knex.schema.hasTable('csit_microcks_sync_status');
  if (hasStatus) {
    await knex.schema.dropTable('csit_microcks_sync_status');
  }
};