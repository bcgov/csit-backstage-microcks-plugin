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

Plugins in this repository are automatically published to **GitHub Packages** using a GitHub Actions workflow.

Publishing occurs when:

- Code is pushed to `main`
- Code is pushed to `feature/*`
- The workflow is manually triggered

The workflow discovers all publishable plugins under `plugins/` and publishes them together.

---

# Versioning

All plugins share the same version during a publish run.

The base version is taken from the root `package.json`.

The CI workflow generates the final version as follows.

## Main branch

```
<root-version-patch+1>-main.<commit-sha>
```

Example:

```
1.2.4-main.a1b2c3d4
```

## Feature branches

```
<root-version>-feature.<branch>.<commit-sha>
```

Example:

```
1.2.3-feature.add-frontend-ui.a1b2c3d4
```

This allows feature branches to publish testable plugin builds without affecting stable releases.

---

# Plugin Package Configuration

Each plugin `package.json` should contain:

```
{
  "version": "0.0.0",
  "private": true
}
```

During publishing the CI workflow:

1. Computes a shared release version
2. Updates each plugin's `package.json`
3. Removes `"private": true`
4. Builds the plugin
5. Packs the plugin
6. Publishes it to GitHub Packages

Before publishing begins:

- All plugins must build successfully
- Target versions must not already exist
- Packages are packed first to verify publish artifacts

Publishing only begins after all checks pass.

---

# GitHub Packages Configuration

Consumers must configure npm to use the GitHub Packages registry.

Add this to `.npmrc`:

```
@bcgov:registry=https://npm.pkg.github.com
```

Authentication with a GitHub token is required.

---

# Installing Plugins

Plugins are published to **GitHub Packages**.

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
npm view @bcgov/<plugin-name>@<version> --registry=https://npm.pkg.github.com
```

Example:

```
npm view @bcgov/csit-microcks-backend-backstage-plugin@1.2.4-feature.my-branch.a1b2c3d4 --registry=https://npm.pkg.github.com
```

## Inspect the Published Package

```
npm pack @bcgov/<plugin-name>@<version> --registry=https://npm.pkg.github.com
```

This downloads the exact tarball that was published so you can inspect its contents.

## Common Issues

**Version already exists**

Publishing fails if the exact package version already exists. This typically happens if a workflow is rerun for the same commit.

**Plugin not detected**

Only directories under `/plugins` containing a `package.json` are considered publishable plugins.

**Missing build artifacts**

Ensure build output is written to `dist/` and included in the `files` field of `package.json`.