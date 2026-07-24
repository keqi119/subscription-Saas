import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const currentFile = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(currentFile), "..");
const schemaPath = resolve(repoRoot, "apps/api/prisma/schema.prisma");
const runtimeRoots = ["apps/api/src", "apps/web/src", "packages/shared/src", "scripts"];
const runtimeExtensions = new Set([".js", ".mjs", ".ts", ".tsx"]);

export function assertVehicleModelEnumRemoved(schemaText, runtimeFiles) {
  const dependencies = findVehicleModelEnumDependencies(schemaText, runtimeFiles);

  if (dependencies.length > 0) {
    const error = new Error("VehicleModel enum dependencies remain.");
    error.dependencies = dependencies;
    throw error;
  }
}

export function findVehicleModelEnumDependencies(schemaText, runtimeFiles) {
  const dependencies = [];
  const uncommentedSchema = stripPrismaComments(schemaText);
  const runtimeAnalysis = createRuntimeAnalysis(runtimeFiles);

  if (/\benum\s+VehicleModel\s*\{/.test(uncommentedSchema)) {
    dependencies.push({ category: "SCHEMA_ENUM_BLOCK", path: "apps/api/prisma/schema.prisma" });
  }

  if (/^(?!\s*enum\s)\s*\w+\s+VehicleModel(?:\?|\[\])?(?:\s|$)/m.test(uncommentedSchema)) {
    dependencies.push({ category: "SCHEMA_ENUM_FIELD", path: "apps/api/prisma/schema.prisma" });
  }

  for (const file of runtimeFiles) {
    const runtimeDependencies = findPrismaVehicleModelRuntimeDependencies(
      runtimeAnalysis.sourceFiles.get(file),
      runtimeAnalysis.checker
    );

    if (runtimeDependencies.hasNamedImport) {
      dependencies.push({ category: "PRISMA_VEHICLE_MODEL_IMPORT", path: file.path });
    }

    if (runtimeDependencies.hasNamespaceUsage) {
      dependencies.push({ category: "PRISMA_VEHICLE_MODEL_NAMESPACE", path: file.path });
    }
  }

  return dependencies.sort((left, right) =>
    left.path === right.path ? left.category.localeCompare(right.category) : left.path.localeCompare(right.path)
  );
}

function stripPrismaComments(schemaText) {
  return schemaText.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function createRuntimeAnalysis(runtimeFiles) {
  const sourceFiles = new Map();
  const sourceFilesByName = new Map();
  const rootNames = [];
  const compilerOptions = {
    allowJs: true,
    checkJs: false,
    jsx: ts.JsxEmit.Preserve,
    module: ts.ModuleKind.ESNext,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest
  };

  for (const file of runtimeFiles) {
    const fileName = resolve(repoRoot, file.path);
    const sourceFile = ts.createSourceFile(
      fileName,
      file.content,
      ts.ScriptTarget.Latest,
      true,
      getScriptKind(file.path)
    );

    sourceFiles.set(file, sourceFile);
    sourceFilesByName.set(canonicalizePath(fileName), sourceFile);
    rootNames.push(fileName);
  }

  const host = {
    fileExists: (fileName) => sourceFilesByName.has(canonicalizePath(fileName)),
    getCanonicalFileName: canonicalizePath,
    getCurrentDirectory: () => repoRoot,
    getDefaultLibFileName: () => "lib.d.ts",
    getDirectories: () => [],
    getNewLine: () => "\n",
    getSourceFile: (fileName) => sourceFilesByName.get(canonicalizePath(fileName)),
    readFile: (fileName) => sourceFilesByName.get(canonicalizePath(fileName))?.text,
    useCaseSensitiveFileNames: () => false,
    writeFile: () => {}
  };
  const program = ts.createProgram({ rootNames, options: compilerOptions, host });

  return { checker: program.getTypeChecker(), sourceFiles };
}

function canonicalizePath(filePath) {
  return filePath.replaceAll("\\", "/").toLowerCase();
}

function findPrismaVehicleModelRuntimeDependencies(sourceFile, checker) {
  const prismaNamespaceBindings = new Map();
  let hasNamedImport = false;
  let hasNamespaceUsage = false;

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && isPrismaModuleSpecifier(statement.moduleSpecifier)) {
      const namedBindings = statement.importClause?.namedBindings;

      if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) {
          const importedName = (element.propertyName ?? element.name).text;

          if (importedName === "VehicleModel") {
            hasNamedImport = true;
          }

          if (importedName === "Prisma") {
            addNamespaceBinding(element.name, "PRISMA");
          }
        }
      }

      if (namedBindings && ts.isNamespaceImport(namedBindings)) {
        addNamespaceBinding(namedBindings.name, "MODULE");
      }

      continue;
    }

    if (ts.isExportDeclaration(statement) && isPrismaModuleSpecifier(statement.moduleSpecifier)) {
      if (!statement.exportClause || ts.isNamespaceExport(statement.exportClause)) {
        hasNamedImport = true;
        continue;
      }

      hasNamedImport ||= statement.exportClause.elements.some(
        (element) => (element.propertyName ?? element.name).text === "VehicleModel"
      );
    }
  }

  collectCommonJsBindings(sourceFile);

  function addNamespaceBinding(identifier, kind) {
    const symbol = checker.getSymbolAtLocation(identifier);

    if (symbol) {
      prismaNamespaceBindings.set(symbol, kind);
    }
  }

  function collectCommonJsBindings(node) {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const requireKind = getPrismaRequireKind(node.initializer);

      if (requireKind === "MODULE" && ts.isIdentifier(node.name)) {
        addNamespaceBinding(node.name, "MODULE");
      }

      if (requireKind === "PRISMA" && ts.isIdentifier(node.name)) {
        addNamespaceBinding(node.name, "PRISMA");
      }

      if (requireKind === "MODULE" && ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          if (!ts.isIdentifier(element.name)) {
            continue;
          }

          const importedName = getBindingElementImportedName(element);

          if (importedName === "VehicleModel") {
            hasNamedImport = true;
          }

          if (importedName === "Prisma") {
            addNamespaceBinding(element.name, "PRISMA");
          }
        }
      }
    }

    ts.forEachChild(node, collectCommonJsBindings);
  }

  function visit(node) {
    if (ts.isImportTypeNode(node) && isPrismaImportType(node)) {
      hasNamedImport = true;
    }

    if (ts.isPropertyAccessExpression(node) || ts.isQualifiedName(node)) {
      const accessPath = getAccessPath(node);

      if (accessPath) {
        const rootSymbol = checker.getSymbolAtLocation(accessPath.root);
        const namespaceKind = rootSymbol ? prismaNamespaceBindings.get(rootSymbol) : undefined;

        if (namespaceKind && isVehicleModelAccess(namespaceKind, accessPath.members)) {
          hasNamespaceUsage = true;
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  return { hasNamedImport, hasNamespaceUsage };
}

function isPrismaModuleSpecifier(node) {
  return Boolean(node && ts.isStringLiteral(node) && node.text === "@prisma/client");
}

function getPrismaRequireKind(node) {
  if (isPrismaRequireCall(node)) {
    return "MODULE";
  }

  if (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "Prisma" &&
    isPrismaRequireCall(node.expression)
  ) {
    return "PRISMA";
  }

  return undefined;
}

function isPrismaRequireCall(node) {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "require" &&
    node.arguments.length === 1 &&
    isPrismaModuleSpecifier(node.arguments[0])
  );
}

function getBindingElementImportedName(element) {
  if (element.propertyName && (ts.isIdentifier(element.propertyName) || ts.isStringLiteral(element.propertyName))) {
    return element.propertyName.text;
  }

  return ts.isIdentifier(element.name) ? element.name.text : undefined;
}

function isPrismaImportType(node) {
  if (
    !ts.isLiteralTypeNode(node.argument) ||
    !ts.isStringLiteral(node.argument.literal) ||
    node.argument.literal.text !== "@prisma/client"
  ) {
    return false;
  }

  const qualifier = node.qualifier ? getEntityNameMembers(node.qualifier) : [];
  return isVehicleModelImportTypePath(qualifier);
}

function getEntityNameMembers(node) {
  if (ts.isIdentifier(node)) {
    return [node.text];
  }

  return [...getEntityNameMembers(node.left), node.right.text];
}

function isVehicleModelImportTypePath(members) {
  return (
    members.length > 0 &&
    members.at(-1) === "VehicleModel" &&
    (members.length === 1 ||
      members.join(".") === "Prisma.VehicleModel" ||
      members.join(".") === "Prisma.$Enums.VehicleModel")
  );
}

function getAccessPath(node) {
  const members = [];
  let current = node;

  while (ts.isPropertyAccessExpression(current)) {
    members.unshift(current.name.text);
    current = current.expression;
  }

  while (ts.isQualifiedName(current)) {
    members.unshift(current.right.text);
    current = current.left;
  }

  return ts.isIdentifier(current) ? { members, root: current } : undefined;
}

function isVehicleModelAccess(namespaceKind, members) {
  const path = members.join(".");

  if (namespaceKind === "PRISMA") {
    return path === "VehicleModel" || path === "$Enums.VehicleModel";
  }

  return (
    path === "VehicleModel" ||
    path === "$Enums.VehicleModel" ||
    path === "Prisma.VehicleModel" ||
    path === "Prisma.$Enums.VehicleModel"
  );
}

function getScriptKind(filePath) {
  switch (extname(filePath).toLowerCase()) {
    case ".ts":
      return ts.ScriptKind.TS;
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".js":
    case ".mjs":
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.Unknown;
  }
}

function readRuntimeFiles() {
  const files = [];

  for (const root of runtimeRoots) {
    collectRuntimeFiles(resolve(repoRoot, root), files);
  }

  return files;
}

function collectRuntimeFiles(currentPath, files) {
  if (!existsSync(currentPath)) {
    return;
  }

  for (const entry of readdirSync(currentPath, { withFileTypes: true })) {
    const nextPath = resolve(currentPath, entry.name);

    if (entry.isDirectory()) {
      if ([".next", ".tmp", "coverage", "dist", "node_modules"].includes(entry.name)) {
        continue;
      }
      collectRuntimeFiles(nextPath, files);
      continue;
    }

    const pathFromRoot = relative(repoRoot, nextPath).replaceAll("\\", "/");
    if (!runtimeExtensions.has(extname(entry.name)) || isExcludedRuntimeFile(pathFromRoot)) {
      continue;
    }

    files.push({ content: readFileSync(nextPath, "utf8"), path: pathFromRoot });
  }
}

function isExcludedRuntimeFile(pathFromRoot) {
  return (
    /\.(spec|test)\.[cm]?[jt]sx?$/.test(pathFromRoot) ||
    pathFromRoot === "scripts/check-vehicle-model-no-enum.mjs" ||
    pathFromRoot.startsWith("scripts/model-definition-backfill") ||
    pathFromRoot.startsWith("scripts/quote-order-model-snapshot-backfill") ||
    pathFromRoot.startsWith("scripts/quote-order-model-code-snapshot-backfill")
  );
}

function main() {
  try {
    assertVehicleModelEnumRemoved(readFileSync(schemaPath, "utf8"), readRuntimeFiles());
  } catch (error) {
    if (error && typeof error === "object" && Array.isArray(error.dependencies)) {
      for (const dependency of error.dependencies) {
        console.error(`${dependency.path}\t${dependency.category}`);
      }
      process.exitCode = 1;
      return;
    }

    console.error("apps/api/prisma/schema.prisma\tSCAN_ERROR");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
