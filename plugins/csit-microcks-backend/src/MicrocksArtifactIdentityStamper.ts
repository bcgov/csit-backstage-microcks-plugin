import fs from 'fs/promises';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export type StagedArtifactRef = {
  filename: string;
  path: string;
};

function isObjectRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function stampOpenApiIdentity(
  doc: unknown,
  desiredTitle: string,
  desiredVersion: string,
): boolean {
  if (!isObjectRecord(doc)) {
    return false;
  }

  if (!('openapi' in doc) && !('swagger' in doc)) {
    return false;
  }

  if (!isObjectRecord(doc.info)) {
    doc.info = {};
  }

  doc.info.title = desiredTitle;
  doc.info.version = desiredVersion;
  return true;
}

function stampMicrocksArtifactIdentity(
  doc: unknown,
  desiredName: string,
  desiredVersion: string,
): boolean {
  if (!isObjectRecord(doc)) {
    return false;
  }

  const kind = typeof doc.kind === 'string' ? doc.kind.trim() : '';
  if (kind !== 'APIMetadata' && kind !== 'APIExamples') {
    return false;
  }

  if (!isObjectRecord(doc.metadata)) {
    doc.metadata = {};
  }

  doc.metadata.name = desiredName;
  doc.metadata.version = desiredVersion;
  return true;
}

export class MicrocksArtifactIdentityStamper {
  async stampArtifactIdentity(params: {
    entityName: string;
    desiredVersion: string;
    mainArtifact: StagedArtifactRef;
    secondaryArtifacts?: StagedArtifactRef[];
  }): Promise<void> {
    const {
      entityName,
      desiredVersion,
      mainArtifact,
      secondaryArtifacts = [],
    } = params;

    const desiredName = normalizeNonEmptyString(entityName);
    if (!desiredName) {
      throw new Error('A non-empty entityName is required for artifact stamping');
    }

    let mainText: string;
    try {
      mainText = await fs.readFile(mainArtifact.path, 'utf8');
    } catch (e) {
      throw new Error(
        `Failed to read staged main artifact "${mainArtifact.filename}" at "${mainArtifact.path}": ${errorMessage(e)}`,
      );
    }

    let mainDoc: unknown;
    try {
      mainDoc = parseYaml(mainText);
    } catch (e) {
      throw new Error(
        `Failed to parse staged main artifact "${mainArtifact.filename}" at "${mainArtifact.path}": ${errorMessage(e)}`,
      );
    }

    if (!stampOpenApiIdentity(mainDoc, desiredName, desiredVersion)) {
      throw new Error(
        `Unable to stamp name/version into staged main artifact "${mainArtifact.filename}" at "${mainArtifact.path}"`,
      );
    }

    try {
      await fs.writeFile(mainArtifact.path, stringifyYaml(mainDoc), 'utf8');
    } catch (e) {
      throw new Error(
        `Failed to write staged main artifact "${mainArtifact.filename}" at "${mainArtifact.path}": ${errorMessage(e)}`,
      );
    }

    for (const artifact of secondaryArtifacts) {
      let text: string;
      try {
        text = await fs.readFile(artifact.path, 'utf8');
      } catch (e) {
        throw new Error(
          `Failed to read staged secondary artifact "${artifact.filename}" at "${artifact.path}": ${errorMessage(e)}`,
        );
      }

      let doc: unknown;
      try {
        doc = parseYaml(text);
      } catch (e) {
        throw new Error(
          `Failed to parse staged secondary artifact "${artifact.filename}" at "${artifact.path}": ${errorMessage(e)}`,
        );
      }

      if (!stampMicrocksArtifactIdentity(doc, desiredName, desiredVersion)) {
        continue;
      }

      try {
        await fs.writeFile(artifact.path, stringifyYaml(doc), 'utf8');
      } catch (e) {
        throw new Error(
          `Failed to write staged secondary artifact "${artifact.filename}" at "${artifact.path}": ${errorMessage(e)}`,
        );
      }
    }
  }
}