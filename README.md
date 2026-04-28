# csit-backstage-microcks-plugin

This repository contains Backstage plugins that integrate **Microcks** with Backstage.

The project currently provides a **backend plugin** used to synchronize API mocks to Microcks. A **frontend plugin** will be added later to provide a UI in Backstage for managing Microcks configuration.

---

# Plugin Documentation

Each plugin in this repository has its own README that contains installation, configuration, and usage instructions.

Current plugins:

| Plugin | Description | Documentation |
|------|------|------|
| `csit-microcks-backend` | Synchronizes API mocks from Backstage catalog entities into Microcks | `plugins/csit-microcks-backend/README.md` |

Future plugins:

| Plugin | Description |
|------|------|
| `csit-microcks-frontend` | Backstage UI for managing Microcks configuration (planned) |

To install and configure a plugin, see the README in the corresponding plugin directory.

Example:

```
plugins/csit-microcks-backend/README.md
```

---

# Repository Structure

Plugins live under the `plugins/` directory.

Example structure:

```
plugins/
  csit-microcks-backend/
    package.json
  csit-microcks-frontend/   (planned)
    package.json
```

Any directory directly under `plugins/` containing a `package.json` is treated as a publishable plugin.

This allows the repository to host multiple related plugins while publishing them independently.

---

# Development

Install dependencies and start the Backstage app:

```
yarn install
yarn start
```

During local development, plugins are used directly from source through Yarn workspaces.

This allows rapid iteration without publishing packages.

---

# Plugin Publishing

Plugins in this repository are automatically published to **GitHub Packages** and **npmjs.org** using a [GitHub Actions workflow in the APS-DevOps repository](https://github.com/bcgov/aps-devops/blob/dev/publish-backstage-plugins/README.md).

Publishing occurs when:

- Code is pushed to `main`
- Code is pushed to `feature/*`
- The workflow is manually triggered

The workflow discovers all publishable plugins under `plugins/` and publishes them together.

---

## Prerequisites

These packages are published to both **npmjs.org** and **GitHub Packages**.

If you are installing the packages from **npmjs.org**, no additional configuration or authentication is required.

If you choose to pull from **GitHub Packages**, follow these steps to authenticate, as it is required even for public packages:

### 1. Create a GitHub Personal Access Token

1. Go to GitHub Settings → Developer settings → Personal access tokens → Tokens (classic)
2. Click **Generate new token (classic)**
3. Give it a descriptive name such as `Backstage Package Access`
4. Select the `read:packages` scope
5. Set a lifespan (90 days or less recommended)
6. Authorize the token for SSO with the `bcgov` organization
7. Copy the token

### 2. Export the Token

```bash
export GITHUB_TOKEN=your_token_here
```

---

## Configure Package Registry Access (GitHub Packages Only)

The following configuration is only required if you are pulling the packages from the GitHub registry instead of npmjs.org.

### `.npmrc`

```
@bcgov:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

### `.yarnrc.yml` (if required)

```yaml
npmScopes:
  bcgov:
    npmRegistryServer: "https://npm.pkg.github.com"

npmRegistries:
  "https://npm.pkg.github.com":
    npmAuthToken: "${GITHUB_TOKEN:-}"
```

---

# Installing Plugins

Plugins are published to **GitHub Packages** and **npmjs.org**.

The GitHub Actions workflow prints the exact install command in the run summary.

Example:

```
yarn add @bcgov/csit-microcks-backend-backstage-plugin@1.2.4-feature.my-branch.a1b2c3d4
```

After installing a plugin, follow the setup instructions in the plugin's README.

Example:

```
plugins/csit-microcks-backend/README.md
```

---

# Release Debugging

If a publish fails or a package cannot be installed, the following checks can help.

## Verify the Package Exists

```
npm view @bcgov/<plugin-name>@<version>
```

Example:

```
npm view @bcgov/csit-microcks-backend-backstage-plugin@1.2.4-feature.my-branch.a1b2c3d4
```

## Inspect the Published Package

```
npm pack @bcgov/<plugin-name>@<version>
```

This downloads the exact tarball that was published so you can inspect its contents.

## Common Issues

**Version already exists**

Publishing fails if the exact package version already exists. This typically happens if a workflow is rerun for the same commit.

**Plugin not detected**

Only directories under `/plugins` containing a `package.json` are considered publishable plugins.

**Missing build artifacts**

Ensure build output is written to `dist/` and included in the `files` field of `package.json`.