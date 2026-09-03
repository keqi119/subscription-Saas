import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

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

function createRegistry(repoRoot) {
  const schemaDirectory = path.join(repoRoot, "release", "contracts", "schemas");
  const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: false });
  ajv.addFormat(
    "uuid",
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  );
  const validators = new Map();
  for (const file of schemaFiles(schemaDirectory)) {
    const schema = JSON.parse(readFileSync(file, "utf8"));
    if (typeof schema.$id !== "string" || schema.$id.length === 0) {
      throw codeError("CONTRACT_SCHEMA_ID_MISSING", { file });
    }
    if (validators.has(schema.$id))
      throw codeError("CONTRACT_SCHEMA_ID_DUPLICATE", { id: schema.$id });
    validators.set(schema.$id, ajv.compile(schema));
  }
  return validators;
}

export function compileAllSchemas(repoRoot = defaultRepoRoot) {
  const validators = createRegistry(repoRoot);
  return Object.freeze({ schemaIds: Object.freeze([...validators.keys()].sort()) });
}

export function validateContract(schemaId, value, { repoRoot = defaultRepoRoot } = {}) {
  const validate = createRegistry(repoRoot).get(schemaId);
  if (!validate) throw codeError("CONTRACT_SCHEMA_UNREGISTERED", { schemaId });
  if (!validate(value)) {
    throw codeError("CONTRACT_SCHEMA_INVALID", {
      schemaId,
      errors: validate.errors?.map(({ instancePath, keyword, message, params }) => ({
        instancePath,
        keyword,
        message,
        params
      }))
    });
  }
}
