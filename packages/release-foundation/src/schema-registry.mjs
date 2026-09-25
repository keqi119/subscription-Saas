import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const legacySchemaIdAliases = Object.freeze({
  "database-target-policy.v1": "database-target-policies.v1",
  "target-policy.v1": "target-policies.v1"
});

function codeError(code, details) {
  return Object.assign(new Error(code), { code, details });
}

function schemaFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? schemaFiles(path.join(directory, entry.name))
        : entry.isFile() && entry.name.endsWith(".schema.json")
          ? [path.join(directory, entry.name)]
          : []
    )
    .sort((left, right) => left.localeCompare(right));
}

function readSchemaSources(repoRoot) {
  const schemaDirectory = path.join(repoRoot, "release", "contracts", "schemas");
  return schemaFiles(schemaDirectory).map((file) => ({ file, bytes: readFileSync(file) }));
}

function createRegistry(repoRoot, sources = readSchemaSources(repoRoot)) {
  const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: false });
  // Opt-in keyword: legacy published schemas retain validateFormats:false.
  ajv.addKeyword({
    keyword: "rfc3339Finite",
    type: "string",
    schemaType: "boolean",
    validate(enabled, value) {
      if (!enabled) return true;
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) return false;
      const epoch = Date.parse(value);
      return (
        Number.isFinite(epoch) && new Date(epoch).toISOString().slice(0, 19) === value.slice(0, 19)
      );
    }
  });
  ajv.addFormat(
    "uuid",
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  );
  const validators = new Map();
  for (const { file, bytes } of sources) {
    const schema = JSON.parse(bytes.toString("utf8"));
    if (typeof schema.$id !== "string" || schema.$id.length === 0) {
      throw codeError("CONTRACT_SCHEMA_ID_MISSING", { file });
    }
    if (validators.has(schema.$id))
      throw codeError("CONTRACT_SCHEMA_ID_DUPLICATE", { id: schema.$id });
    const filenameId = path.basename(file).slice(0, -".schema.json".length);
    if ((legacySchemaIdAliases[filenameId] ?? filenameId) !== schema.$id) {
      throw codeError("CONTRACT_SCHEMA_FILENAME_ID_MISMATCH", { file, id: schema.$id });
    }
    validators.set(schema.$id, ajv.compile(schema));
  }
  return validators;
}

let lastRegistry;

function validationRegistry(repoRoot) {
  const root = path.resolve(repoRoot);
  const sources = readSchemaSources(repoRoot);
  if (
    lastRegistry?.root === root &&
    sources.length === lastRegistry.sources.length &&
    sources.every(
      ({ file, bytes }, index) =>
        file === lastRegistry.sources[index].file && bytes.equals(lastRegistry.sources[index].bytes)
    )
  ) {
    return lastRegistry.validators;
  }
  // Compile the exact bytes just observed; failed reads/compilation never fall back to old validators.
  const validators = createRegistry(repoRoot, sources);
  lastRegistry = { root, sources, validators };
  return validators;
}

export function compileAllSchemas(repoRoot = defaultRepoRoot) {
  const validators = createRegistry(repoRoot);
  return Object.freeze({ schemaIds: Object.freeze([...validators.keys()].sort()) });
}

export function validateContract(schemaId, value, { repoRoot = defaultRepoRoot } = {}) {
  const validate = validationRegistry(repoRoot).get(schemaId);
  if (!validate) throw codeError("CONTRACT_SCHEMA_UNREGISTERED", { schemaId });
  if (!validate(value)) {
    throw codeError("CONTRACT_SCHEMA_INVALID", {
      schemaId,
      errors: validate.errors?.map(({ instancePath, keyword, message, params }) => ({
        instancePath,
        keyword,
        message,
        // Ajv const/enum error parameters can reference the compiled schema.
        params: structuredClone(params)
      }))
    });
  }
}
