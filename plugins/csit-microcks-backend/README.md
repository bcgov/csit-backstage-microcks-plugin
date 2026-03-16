# CSIT Microcks Backend Plugin

This Backstage backend plugin synchronizes API mocks defined in a repository into a **Microcks** server.

The plugin reads configuration from catalog entities, determines the desired state of mocks, and reconciles Microcks so that the correct mock services exist.

The system is intentionally designed to be **deterministic**, **observable**, and **fail fast**.

---

# Installation

Install the plugin in your Backstage backend.

```
yarn add @bcgov/csit-microcks-backend-backstage-plugin
```

Register the plugin in your backend.

Example (`packages/backend/src/index.ts`):

```
backend.add(import('@bcgov/csit-microcks-backend-backstage-plugin'));
```

Restart the backend after installing the plugin.

---

# Configuration

Backstage `app-config.yaml` must define a Microcks server.

Example:

```
csitMicrocks:
  server:
    baseUrl: https://csit-microcks-apps-gov-bc-ca.dev.api.gov.bc.ca
    auth:
      type: keycloak
      issuerUrl: https://authz-b8840c-dev.apps.gold.devops.gov.bc.ca/auth/realms/aps
      clientId: devhub-microcks-sync
      clientSecret: ${BACKSTAGE_MICROCKS_CLIENT_SECRET}
```

If this configuration is missing:

- The processor continues queuing jobs
- The worker **will not claim jobs**

---

# Keycloak Service Client Configuration

The backend plugin authenticates to Microcks using the **OAuth 2.0 client credentials flow** via Keycloak.

A **Keycloak confidential client with a service account** must be created so the plugin can obtain access tokens.

Recommended client id:

```
devhub-microcks-sync
```

The client id is configurable in `app-config.yaml`.

The service client must be granted the role:

```
microcks-app → manager
```

This role allows the plugin to perform Microcks operations such as importing artifacts and managing services.

---

## Keycloak 26 Setup

Create the client in the same Keycloak realm used by Microcks.

### 1. Create the Client

1. Open the **Keycloak Admin Console**
2. Select the **Microcks realm**
3. Navigate to **Clients**
4. Click **Create client**

Configure:

Client ID

```
devhub-microcks-sync
```

Client Type

```
OpenID Connect
```

Click **Next**.

Enable the following settings:

- Client authentication
- Service accounts roles

Save the client.

---

### 2. Obtain the Client Secret

1. Open the client you created
2. Navigate to the **Credentials** tab
3. Copy the **Client Secret**

Store the secret securely. It should **not be committed to source control**.

---

### 3. Assign the Required Role

1. Open the client
2. Navigate to **Service Account Roles**
3. Change the filter to **Filter by clients**
4. Select:

```
microcks-app
```

5. Assign the role:

```
manager
```

The service client can now perform Microcks management operations.

---

# Entity Configuration

Catalog entities enable Microcks synchronization using the annotation:

```
bcgov/microcks-config-ref
```

Example:

```
metadata:
  annotations:
    bcgov/microcks-config-ref: ./microcks.yaml
```

The referenced file defines one or more mocks.

Example structure:

```
spec:
  mocks:
    - mockId: default
      openapi:
        path: openapi.yaml
      artifacts:
        - kind: examples
          path: examples
```

Artifacts may reference:

- local repository paths
- URLs

Multiple mocks per API are supported.

---

# Architecture

```mermaid
flowchart LR

A[Backstage Catalog Entity] --> B[CsitMicrocksProcessor]

B --> C[(csit_microcks_sync_status)]

C --> D[MicrocksSyncWorker]

D --> E[MicrocksSyncJobRunner]

E --> F[MicrocksDesiredStateLoader]
E --> G[MicrocksReconciler]
E --> H[MicrocksClient]

F --> I[Repository Artifacts]

H --> J[Microcks Server]

B --> K[(csit_microcks_sync_events)]
E --> K
```

## Flow Summary

1. A catalog entity references a `microcks.yaml` file.
2. The **Catalog Processor** reads this file and records desired sync state.
3. The **Background Worker** polls the database for pending jobs.
4. Each job is executed by the **Job Runner**.
5. The job runner loads artifacts, reconciles Microcks services, and records events.

Both the **processor** and **worker** emit events for observability.

---

# Developer Workflow

This section describes what happens when a developer updates `microcks.yaml` in a repository.

Understanding this flow helps when debugging synchronization behavior.

---

## Step 1 — Developer Updates microcks.yaml

A developer modifies the mock configuration referenced by a catalog entity.

Example changes:

- add a new mock
- update OpenAPI
- add example responses
- remove a mock

The change is committed to the repository.

---

## Step 2 — Backstage Catalog Processing

During the next catalog refresh:

`CsitMicrocksProcessor`

runs for the entity.

The processor:

1. Detects the annotation

```
bcgov/microcks-config-ref
```

2. Loads the `microcks.yaml` file.
3. Parses mock definitions.
4. Computes a **fingerprint hash** of inputs.
5. Upserts rows in:

```
csit_microcks_sync_status
```

### Possible outcomes

| Scenario | Result |
|--------|--------|
| New mock | `desired_action = reconcile` |
| Updated configuration | `desired_action = reconcile` |
| Removed mock | `desired_action = delete` |
| No changes | no new job created |

The processor **does not communicate with Microcks**.

Its responsibility is to determine **desired state** and record synchronization jobs.

Processor activity is also recorded in the event table for observability.

---

## Step 3 — Job Appears in Database

Example record:

| field | value |
|-----|------|
| entity_ref | component:default/my-api |
| mock_id | default |
| desired_action | reconcile |
| microcks_version_id | bk-8ad514d6fc316e04-default |
| status | pending |

The record waits to be claimed by the worker.

---

## Step 4 — Worker Claims the Job

`MicrocksSyncWorker` periodically polls the database.

The worker:

1. checks configuration
2. verifies global backoff is not active
3. claims a job using a **lease**

```
claimNextPending()
```

The job status transitions to **leased**.

---

## Step 5 — Job Runner Executes the Sync

Execution is delegated to:

```
MicrocksSyncJobRunner
```

The runner performs the following steps.

### 1) Load Desired State

```
MicrocksDesiredStateLoader
```

Loads:

- OpenAPI specification
- example artifacts
- metadata

Artifacts may come from:

- repository files
- URLs

### 2) Scan Existing Microcks Services

Ownership is determined using:

```
bk-<entityHash>
```

Example:

```
bk-8ad514d6fc316e04-*
```

### 3) Reconcile Desired vs Existing

`MicrocksReconciler` determines:

- services owned by the entity
- exact version matches
- services to delete
- whether action is `create` or `update`

### 4) Upload Artifacts

Artifacts are uploaded using:

```
MicrocksClient.uploadArtifacts()
```

Before upload:

```
MicrocksArtifactIdentityStamper
```

injects deterministic identity metadata.

### 5) Delete Stale Services

Any services owned by the entity that are not part of the desired version set are deleted.

This ensures:

```
Microcks always reflects the desired configuration
```

---

## Step 6 — Job Completion

If successful:

```
status = completed
```

The worker records events in:

```
csit_microcks_sync_events
```

Example events:

- reconcile_started
- artifact_upload_started
- artifact_upload_finished
- reconcile_finished

---

# Versioning Model

Microcks service versions are deterministic.

Format

```
bk-<entityHash>-<mockId>
```

Example

```
bk-8ad514d6fc316e04-default
bk-8ad514d6fc316e04-swagger
bk-8ad514d6fc316e04-sdpr
```

Ownership of services is determined by the prefix:

```
bk-<entityHash>
```

---

# Reconciliation Model

Reconciliation is handled by:

```
MicrocksReconciler
```

The worker ensures that **only the desired versions exist in Microcks**.

---

# Fail Fast Behavior

If desired state cannot be loaded:

1. A failure event is recorded
2. Microcks services owned by the failed mock are deleted
3. The sync record is marked `error`

---

# Database Tables

## csit_microcks_sync_status

Tracks synchronization jobs.

| Field | Description |
|------|-------------|
| id | primary key |
| entity_ref | Backstage entity reference |
| mock_id | mock identifier |
| desired_action | reconcile or delete |
| microcks_version_id | deterministic Microcks version |
| fingerprint_hash | processor fingerprint |
| status | pending, completed, error |

---

## csit_microcks_sync_events

Stores detailed sync history.

| Field | Description |
|------|-------------|
| entity_ref | entity reference |
| mock_id | mock identifier |
| sync_status_id | sync record id |
| event_type | event category |
| level | info or error |
| message | event message |

---

# Important Classes

| Class | Responsibility |
|------|---------------|
| `CsitMicrocksProcessor` | Reads entity configuration and queues sync jobs |
| `MicrocksSyncWorker` | Polls database and orchestrates job execution |
| `MicrocksSyncJobRunner` | Executes a single sync job |
| `MicrocksDesiredStateLoader` | Loads artifacts |
| `MicrocksClient` | Communicates with the Microcks API |
| `MicrocksReconciler` | Determines required actions |
| `MicrocksTokenProvider` | Handles authentication tokens |
| `MicrocksArtifactIdentityStamper` | Injects deterministic artifact identity |
| `MicrocksSyncStore` | Database access layer |

---

# Design Principles

### Deterministic Versioning

Microcks service versions derive from entity identity and `mockId`.

### Fail Fast Behavior

Invalid configuration immediately removes owned mocks.

### Explicit Ownership

Service ownership is determined by the entity version prefix.

### Observable Operations

All actions emit events to `csit_microcks_sync_events`.

### Small Focused Components

Worker orchestration, job execution, reconciliation, and storage are separated into focused classes.