import { createHash } from "node:crypto";

const ADMIN_USERNAME = "keqi_119";
const CUSTOMER_PHONE = "18616570212";
const SOURCE_DATABASE_NAME = "subscription_saas_staging";
const TARGET_DATABASE_NAME = /^subscription_saas_staging_acceptance_[a-z0-9_]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const IMAGE_REF = /^.+@sha256:[0-9a-f]{64}$/;
const STABLE_ERROR_CODES = new Set([
  "ADMIN_AMBIGUOUS",
  "ADMIN_NOT_FOUND",
  "ADMIN_ROLE_INCOMPLETE",
  "CATALOG_ACTIVE_SET_EMPTY",
  "CATALOG_REFERENCE_NOT_CLOSED",
  "CONTRACT_TEMPLATE_AMBIGUOUS",
  "CONTRACT_TEMPLATE_FILE_INVALID",
  "CONTRACT_TEMPLATE_REQUIRED",
  "CUSTOMER_AMBIGUOUS",
  "CUSTOMER_ESIGN_BINDING_INVALID",
  "CUSTOMER_NOT_FOUND",
  "DATABASE_ALLOWED_HOSTNAME_REQUIRED",
  "DATABASE_HOSTNAME_MISMATCH",
  "DATABASE_HOSTNAME_NOT_ALLOWED",
  "DATABASE_IDENTITY_INVALID",
  "DATABASE_PAIR_SAME_DATABASE",
  "DATABASE_PORT_MISMATCH",
  "DATABASE_PROTOCOL_MISMATCH",
  "DATABASE_TLS_POLICY_MISMATCH",
  "DATABASE_USERNAME_MISMATCH",
  "FORBIDDEN_DOMAIN_NOT_EMPTY",
  "IDENTITY_SELECTION_NOT_ALLOWED",
  "MANIFEST_CLASSIFICATION_INVALID",
  "MANIFEST_CONTEXT_INVALID",
  "MANIFEST_STALE",
  "NOTIFICATION_TEMPLATE_REQUIRED",
  "SOURCE_DATABASE_NOT_ALLOWED",
  "STAGE1_ACCEPTANCE_ERROR",
  "TARGET_COUNT_EVIDENCE_INVALID",
  "TARGET_DATABASE_NOT_ALLOWED",
  "TARGET_NOT_EMPTY",
  "TARGET_SCHEMA_NOT_CANONICAL",
  "VEHICLE_ID_INVALID",
  "VEHICLE_NOT_ELIGIBLE",
  "VEHICLE_REFERENCE_NOT_CLOSED",
  "VEHICLE_SELECTION_REQUIRED"
]);
const STABLE_EXCEPTION_DOMAINS = new Set([
  "access",
  "catalog",
  "customer",
  "database",
  "manifest",
  "selection",
  "target",
  "templates",
  "unknown",
  "vehicle"
]);
const CLASSIFICATION_DOMAINS = ["access", "customer", "catalog", "templates", "vehicle"];

export function parseStage1CleanAcceptanceSelection(input = {}) {
  if (input.adminUsername !== ADMIN_USERNAME || input.customerPhone !== CUSTOMER_PHONE) {
    fail("IDENTITY_SELECTION_NOT_ALLOWED");
  }
  if (!Array.isArray(input.vehicleIds)) fail("VEHICLE_ID_INVALID");
  const vehicleIds = input.vehicleIds.map((value) => {
    if (typeof value !== "string" || !UUID.test(value.toLowerCase())) fail("VEHICLE_ID_INVALID");
    return value.toLowerCase();
  });
  return {
    adminUsername: ADMIN_USERNAME,
    customerPhone: CUSTOMER_PHONE,
    vehicleIds: [...new Set(vehicleIds)].sort()
  };
}

export function parseStage1AcceptanceDatabaseIdentity(databaseUrl) {
  let url;
  try {
    url = new URL(databaseUrl);
  } catch {
    fail("DATABASE_IDENTITY_INVALID");
  }
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  if (!databaseName || databaseName.includes("/")) fail("DATABASE_IDENTITY_INVALID");
  return {
    databaseName,
    hostname: url.hostname.toLowerCase(),
    port: url.port || "5432",
    protocol: url.protocol.toLowerCase(),
    tlsPolicy: tlsPolicy(url),
    username: decodeURIComponent(url.username)
  };
}

export function assertStage1AcceptanceDatabasePair(sourceUrl, targetUrl, options = {}) {
  const source = parseStage1AcceptanceDatabaseIdentity(sourceUrl);
  const target = parseStage1AcceptanceDatabaseIdentity(targetUrl);
  if (source.databaseName !== SOURCE_DATABASE_NAME) fail("SOURCE_DATABASE_NOT_ALLOWED");
  if (source.databaseName === target.databaseName) fail("DATABASE_PAIR_SAME_DATABASE");
  if (!TARGET_DATABASE_NAME.test(target.databaseName)) fail("TARGET_DATABASE_NOT_ALLOWED");
  if (typeof options.allowedHostname !== "string" || !options.allowedHostname) {
    fail("DATABASE_ALLOWED_HOSTNAME_REQUIRED");
  }
  if (source.hostname !== target.hostname) fail("DATABASE_HOSTNAME_MISMATCH");
  if (source.hostname !== options.allowedHostname.toLowerCase() || target.hostname !== options.allowedHostname.toLowerCase()) {
    fail("DATABASE_HOSTNAME_NOT_ALLOWED");
  }
  if (source.protocol !== target.protocol) fail("DATABASE_PROTOCOL_MISMATCH");
  if (source.port !== target.port) fail("DATABASE_PORT_MISMATCH");
  if (source.username !== target.username) fail("DATABASE_USERNAME_MISMATCH");
  if (source.tlsPolicy !== target.tlsPolicy) fail("DATABASE_TLS_POLICY_MISMATCH");
  return { source, target };
}

export function classifyStage1CleanAcceptanceBaseline(snapshot = {}, inputSelection = {}) {
  const selection = parseStage1CleanAcceptanceSelection(inputSelection);
  const exceptions = [];
  const access = classifyAccess(snapshot.access, selection, exceptions);
  const customer = classifyCustomer(snapshot.customer, selection, exceptions);
  const catalog = classifyCatalog(snapshot.catalog, exceptions);
  const templates = classifyTemplates(snapshot.templates, exceptions);
  const vehicle = classifyVehicle(snapshot.vehicle, selection, exceptions);
  const targetCountEvidence = copyTargetCountEvidence(snapshot.target);
  const targetForbiddenCounts = canonical(targetCountEvidence.forbiddenCounts ?? {});
  classifyTarget(snapshot.target, targetCountEvidence, exceptions);

  const rows = { access, customer, catalog, templates, vehicle };
  const counts = Object.fromEntries(
    Object.entries(rows).map(([domain, value]) => [domain, countRows(value)])
  );
  const rowDigests = Object.fromEntries(
    Object.entries(rows).map(([domain, value]) => [domain, digest(`stage1-acceptance:rows:${domain}:`, stableJson(value))])
  );
  const sortedExceptions = exceptions.sort(compareException);
  const safeToApply = sortedExceptions.length === 0 && allZero(targetForbiddenCounts);
  return {
    safeToApply,
    selection,
    rows,
    counts,
    rowDigests,
    exceptions: sortedExceptions,
    targetForbiddenCounts,
    targetCountEvidence
  };
}

export function buildStage1CleanAcceptanceManifest(classification, context = {}) {
  requireContext(context);
  requireClassification(classification);
  const selection = parseStage1CleanAcceptanceSelection(classification?.selection);
  return canonical({
    schemaVersion: 1,
    operation: "STAGE1_CLEAN_ACCEPTANCE_BASELINE",
    gitSha: context.gitSha,
    imageRef: context.imageRef,
    source: digestContext(context.source),
    target: digestContext(context.target),
    selection: {
      adminDigest: saltedDigest("stage1-acceptance:admin:", selection.adminUsername, context.hashSalt),
      customerDigest: saltedDigest("stage1-acceptance:customer:", selection.customerPhone, context.hashSalt),
      vehicleDigests: selection.vehicleIds
        .map((vehicleId) => saltedDigest("stage1-acceptance:vehicle:", vehicleId, context.hashSalt))
        .sort()
    },
    counts: classification.counts ?? {},
    rowDigests: buildManifestRowDigests(classification.rows, context.hashSalt),
    exceptions: array(classification.exceptions).map((value) => redactException(value, context.hashSalt)),
    safeToApply: isStage1CleanAcceptanceBaselineSafe(classification),
    generatedAt: context.generatedAt,
    hashSalt: context.hashSalt
  });
}

export function hashStage1CleanAcceptanceManifest(manifest) {
  return digest("", stableJson(canonical(manifest)));
}

export function isStage1CleanAcceptanceBaselineSafe(classification = {}) {
  return (
    classification.safeToApply === true &&
    array(classification.exceptions).length === 0 &&
    validTargetCountEvidence(classification.targetCountEvidence) &&
    sameCounts(classification.targetForbiddenCounts, classification.targetCountEvidence.forbiddenCounts) &&
    allZero(classification.targetCountEvidence.forbiddenCounts) &&
    allZero(classification.targetCountEvidence.tableCounts)
  );
}

export function redactStage1CleanAcceptanceError(error) {
  const code = typeof error?.code === "string" ? error.code : typeof error?.message === "string" ? error.message : "STAGE1_ACCEPTANCE_ERROR";
  return { code: stableCode(code) };
}

function classifyAccess(access = {}, selection, exceptions) {
  const users = active(array(access.users).filter((row) => row.username === selection.adminUsername));
  if (users.length === 0) exception(exceptions, "ADMIN_NOT_FOUND", "access", selection.adminUsername);
  if (users.length > 1) exception(exceptions, "ADMIN_AMBIGUOUS", "access", selection.adminUsername);
  const admin = users.length === 1 ? users[0] : undefined;
  const roles = active(array(access.roles));
  const adminRole = roles.filter((role) => role.code === "ADMIN");
  const userRoles = admin ? array(access.userRoles).filter((row) => row.userId === admin.id) : [];
  const hasAdminRole = userRoles.some((row) => adminRole.some((role) => role.id === row.roleId));
  const rolePermissions = array(access.rolePermissions).filter((row) => userRoles.some((userRole) => userRole.roleId === row.roleId));
  const roleMenus = array(access.roleMenus).filter((row) => userRoles.some((userRole) => userRole.roleId === row.roleId));
  const permissions = active(array(access.permissions).filter((row) => rolePermissions.some((grant) => grant.permissionId === row.id)));
  const menus = active(array(access.menus).filter((row) => roleMenus.some((grant) => grant.menuId === row.id)));
  if (admin && (!hasAdminRole || permissions.length === 0 || menus.length === 0)) {
    exception(exceptions, "ADMIN_ROLE_INCOMPLETE", "access", admin.id);
  }
  return sortRows({
    menus,
    permissions,
    roleMenus,
    rolePermissions,
    roles: roles.filter((role) => userRoles.some((userRole) => userRole.roleId === role.id)),
    userRoles,
    users
  });
}

function classifyCustomer(customer = {}, selection, exceptions) {
  const accounts = active(array(customer.customerAccounts).filter((row) => row.phone === selection.customerPhone));
  if (accounts.length === 0) exception(exceptions, "CUSTOMER_NOT_FOUND", "customer", selection.customerPhone);
  if (accounts.length > 1) exception(exceptions, "CUSTOMER_AMBIGUOUS", "customer", selection.customerPhone);
  const account = accounts.length === 1 ? accounts[0] : undefined;
  const customers = account ? active(array(customer.customers).filter((row) => row.id === account.customerId)) : [];
  if (account && customers.length !== 1) exception(exceptions, customers.length === 0 ? "CUSTOMER_NOT_FOUND" : "CUSTOMER_AMBIGUOUS", "customer", account.customerId);
  const customerId = customers[0]?.id;
  const identities = active(array(customer.customerIdentities).filter((row) => row.customerId === customerId));
  const profiles = active(array(customer.customerProfiles).filter((row) => row.customerId === customerId));
  const eSignAccounts = active(array(customer.customerESignProviderAccounts).filter((row) => row.customerId === customerId));
  if (customerId && (identities.length === 0 || profiles.length === 0 || eSignAccounts.length !== 1 || !eSignAccounts[0].providerAccountId)) {
    exception(exceptions, "CUSTOMER_ESIGN_BINDING_INVALID", "customer", customerId);
  }
  return sortRows({
    customerAccounts: accounts,
    customerESignProviderAccounts: eSignAccounts,
    customerIdentities: identities,
    customerProfiles: profiles,
    customers
  });
}

function classifyCatalog(catalog = {}, exceptions) {
  const products = active(array(catalog.products));
  const productVersions = active(array(catalog.productVersions));
  const depositRules = active(array(catalog.depositRules));
  const vehiclePackages = active(array(catalog.vehiclePackages));
  const subscriptionPlans = active(array(catalog.subscriptionPlans));
  if (products.length === 0 || productVersions.length === 0 || subscriptionPlans.length === 0) {
    exception(exceptions, "CATALOG_ACTIVE_SET_EMPTY", "catalog", "active");
  }
  const closed = productVersions.every((row) => products.some((item) => item.id === row.productId) && depositRules.some((item) => item.id === row.depositRuleId)) &&
    subscriptionPlans.every((row) => productVersions.some((item) => item.id === row.productVersionId) && vehiclePackages.some((item) => item.id === row.vehiclePackageId));
  if (!closed) exception(exceptions, "CATALOG_REFERENCE_NOT_CLOSED", "catalog", "references");
  return sortRows({ depositRules, products, productVersions, subscriptionPlans, vehiclePackages });
}

function classifyTemplates(templates = {}, exceptions) {
  const contractVersions = active(array(templates.contractVersions));
  const allFileObjects = array(templates.fileObjects);
  const notificationTemplates = active(array(templates.notificationTemplates));
  const requiredContractCodes = requiredCodes(templates.requiredContractTemplateCodes);
  const requiredNotificationCodes = requiredCodes(templates.requiredNotificationTemplateCodes);
  const selectedContractVersions = [];
  const selectedFiles = [];
  const selectedNotifications = [];
  if (requiredContractCodes.length === 0) {
    exception(exceptions, "CONTRACT_TEMPLATE_REQUIRED", "templates", "required-contract-codes");
  }
  if (requiredNotificationCodes.length === 0) {
    exception(exceptions, "NOTIFICATION_TEMPLATE_REQUIRED", "templates", "required-notification-codes");
  }
  for (const code of requiredContractCodes) {
    const versions = contractVersions.filter((row) => row.templateCode === code);
    if (versions.length !== 1) {
      exception(
        exceptions,
        versions.length > 1 ? "CONTRACT_TEMPLATE_AMBIGUOUS" : "CONTRACT_TEMPLATE_REQUIRED",
        "templates",
        code
      );
      continue;
    }
    const row = versions[0];
    const files = allFileObjects.filter((item) => item?.id === row.fileId);
    if (files.length !== 1 || !validPdfFile(files[0])) {
      exception(exceptions, "CONTRACT_TEMPLATE_FILE_INVALID", "templates", row.id);
      continue;
    }
    selectedContractVersions.push(row);
    selectedFiles.push(files[0]);
  }
  for (const code of requiredNotificationCodes) {
    const notifications = notificationTemplates.filter((row) => row.code === code);
    if (notifications.length !== 1) {
      exception(exceptions, "NOTIFICATION_TEMPLATE_REQUIRED", "templates", code);
      continue;
    }
    selectedNotifications.push(notifications[0]);
  }
  return sortRows({
    contractVersions: selectedContractVersions,
    fileObjects: selectedFiles,
    notificationTemplates: selectedNotifications
  });
}

function classifyVehicle(vehicle = {}, selection, exceptions) {
  const closure = {
    assetOwners: [],
    vehicleListingProfiles: [],
    vehicleModelDefinitions: [],
    vehicles: []
  };
  if (selection.vehicleIds.length === 0) {
    exception(exceptions, "VEHICLE_SELECTION_REQUIRED", "vehicle", "selection");
    return closure;
  }
  const vehicles = array(vehicle.vehicles);
  for (const vehicleId of selection.vehicleIds) {
    const matches = vehicles.filter((row) => row?.id === vehicleId);
    if (matches.length !== 1 || matches[0].status !== "AVAILABLE" || matches[0].deletedAt != null) {
      exception(exceptions, "VEHICLE_NOT_ELIGIBLE", "vehicle", vehicleId);
      continue;
    }
    const item = matches[0];
    const owners = active(array(vehicle.assetOwners)).filter((row) => row.id === item.assetOwnerId);
    const models = active(array(vehicle.vehicleModelDefinitions)).filter((row) => row.id === item.vehicleModelDefinitionId);
    const profiles = active(array(vehicle.vehicleListingProfiles)).filter((row) => row.id === item.listingProfileId && row.vehicleId === item.id);
    if (owners.length !== 1 || models.length !== 1 || profiles.length !== 1) {
      exception(exceptions, "VEHICLE_REFERENCE_NOT_CLOSED", "vehicle", item.id);
      continue;
    }
    closure.vehicles.push(item);
    closure.assetOwners.push(owners[0]);
    closure.vehicleModelDefinitions.push(models[0]);
    closure.vehicleListingProfiles.push(profiles[0]);
  }
  return sortRows(closure);
}

function classifyTarget(target = {}, countEvidence, exceptions) {
  if (target.schemaCanonical !== true) exception(exceptions, "TARGET_SCHEMA_NOT_CANONICAL", "target", "schema");
  if (!validTargetCountEvidence(countEvidence)) {
    exception(exceptions, "TARGET_COUNT_EVIDENCE_INVALID", "target", "counts");
    return;
  }
  if (!allZero(countEvidence.tableCounts)) exception(exceptions, "TARGET_NOT_EMPTY", "target", "rows");
  if (!allZero(countEvidence.forbiddenCounts)) exception(exceptions, "FORBIDDEN_DOMAIN_NOT_EMPTY", "target", "forbidden");
}

function digestContext(context) {
  return {
    databaseDigest: context?.databaseDigest ?? "",
    migrationCatalogDigest: context?.migrationCatalogDigest ?? "",
    schemaDigest: context?.schemaDigest ?? ""
  };
}

function requireContext(context) {
  if (
    !GIT_SHA.test(context.gitSha ?? "") ||
    !IMAGE_REF.test(context.imageRef ?? "") ||
    !validIsoTimestamp(context.generatedAt) ||
    !SHA256.test(context.hashSalt ?? "") ||
    !validDigestContext(context.source) ||
    !validDigestContext(context.target)
  ) fail("MANIFEST_CONTEXT_INVALID");
}

function requireClassification(classification) {
  if (!classification || typeof classification !== "object" || typeof classification.safeToApply !== "boolean") {
    fail("MANIFEST_CLASSIFICATION_INVALID");
  }
  try {
    parseStage1CleanAcceptanceSelection(classification.selection);
  } catch {
    fail("MANIFEST_CLASSIFICATION_INVALID");
  }
  if (!hasExactKeys(classification.rows, CLASSIFICATION_DOMAINS)) {
    fail("MANIFEST_CLASSIFICATION_INVALID");
  }
  if (!validDomainCounts(classification.counts) || !validDomainDigests(classification.rowDigests) || !Array.isArray(classification.exceptions)) {
    fail("MANIFEST_CLASSIFICATION_INVALID");
  }
  if (!validTargetCountEvidence(classification.targetCountEvidence) || !sameCounts(classification.targetForbiddenCounts, classification.targetCountEvidence.forbiddenCounts)) {
    fail("MANIFEST_CLASSIFICATION_INVALID");
  }
  if (classification.safeToApply && !isStage1CleanAcceptanceBaselineSafe(classification)) {
    fail("MANIFEST_CLASSIFICATION_INVALID");
  }
}

function redactException(value, hashSalt) {
  const code = stableCode(value?.code);
  const domain = stableDomain(value?.domain);
  const sourceDigest = SHA256.test(value?.subjectDigest ?? "") ? value.subjectDigest : digest("stage1-acceptance:exception:unknown:", "invalid");
  return {
    code,
    domain,
    subjectDigest: saltedDigest(`stage1-acceptance:exception:${domain}:`, sourceDigest, hashSalt)
  };
}

function exception(exceptions, code, domain, subject) {
  exceptions.push({
    code: stableCode(code),
    domain: stableDomain(domain),
    subjectDigest: digest(`stage1-acceptance:exception:${stableDomain(domain)}:`, String(subject))
  });
}

function active(rows) {
  return rows.filter((row) => row && row.deletedAt == null && row.status === "ACTIVE");
}

function sortRows(value) {
  if (Array.isArray(value)) return [...value].sort(compareBusinessRow);
  return Object.fromEntries(Object.entries(value).map(([key, rows]) => [key, sortRows(rows)]));
}

function countRows(value) {
  return Array.isArray(value) ? value.length : Object.values(value).reduce((total, rows) => total + countRows(rows), 0);
}

function tlsPolicy(url) {
  const sslmode = url.searchParams.get("sslmode");
  if (sslmode) return sslmode.toLowerCase();
  const ssl = url.searchParams.get("ssl");
  if (ssl === "true" || ssl === "1") return "require";
  if (ssl === "false" || ssl === "0") return "disable";
  return "unspecified";
}

function saltedDigest(prefix, value, salt) {
  return digest(prefix, `${salt}:${value}`);
}

function digest(prefix, value) {
  return createHash("sha256").update(`${prefix}${value}`, "utf8").digest("hex");
}

function stableJson(value) {
  return JSON.stringify(canonical(value));
}

function canonical(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical).sort(compareValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  if (typeof value === "bigint") return value.toString();
  return value;
}

function compareValue(left, right) {
  return stableJson(left).localeCompare(stableJson(right));
}

function compareException(left, right) {
  return `${left.code}|${left.domain}|${left.subjectDigest}`.localeCompare(`${right.code}|${right.domain}|${right.subjectDigest}`);
}

function compareBusinessRow(left, right) {
  const leftKey = businessKey(left);
  const rightKey = businessKey(right);
  return leftKey.localeCompare(rightKey) || compareValue(left, right);
}

function businessKey(row) {
  if (!row || typeof row !== "object") return stableJson(row);
  for (const key of ["id", "code", "username", "phone", "templateCode", "vehicleId", "roleId", "permissionId", "menuId"]) {
    if (typeof row[key] === "string") return `${key}:${row[key]}`;
  }
  return stableJson(row);
}

function allZero(counts) {
  return validCountMap(counts, Object.keys(counts)) && Object.values(counts).every((count) => count === 0);
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function nonEmpty(value) {
  return typeof value === "string" && value.length > 0;
}

function positive(value) {
  return (typeof value === "number" && value > 0) || (typeof value === "bigint" && value > 0n);
}

function requiredCodes(value) {
  if (!Array.isArray(value) || value.length === 0 || value.some((code) => !nonEmpty(code))) return [];
  return [...new Set(value)].sort();
}

function validPdfFile(file) {
  return Boolean(file) &&
    nonEmpty(file.id) &&
    nonEmpty(file.bucket) &&
    nonEmpty(file.objectKey) &&
    nonEmpty(file.originalName) &&
    typeof file.mimeType === "string" &&
    file.mimeType.toLowerCase().split(";", 1)[0].trim() === "application/pdf" &&
    positive(file.sizeBytes) &&
    SHA256.test(file.contentSha256 ?? "");
}

function copyTargetCountEvidence(target = {}) {
  return {
    forbiddenCountKeys: array(target.forbiddenCountKeys),
    forbiddenCounts: target.forbiddenCounts,
    tableCountKeys: array(target.tableCountKeys),
    tableCounts: target.tableCounts
  };
}

function validTargetCountEvidence(value) {
  return Boolean(value) &&
    validCountMap(value.forbiddenCounts, value.forbiddenCountKeys) &&
    validCountMap(value.tableCounts, value.tableCountKeys);
}

function validCountMap(counts, countKeys) {
  if (!counts || typeof counts !== "object" || Array.isArray(counts) || !Array.isArray(countKeys) || countKeys.length === 0) return false;
  const actualKeys = Object.keys(counts).sort();
  const expectedKeys = [...countKeys].sort();
  return (
    new Set(expectedKeys).size === expectedKeys.length &&
    expectedKeys.every((key) => nonEmpty(key)) &&
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index]) &&
    actualKeys.every((key) => Number.isSafeInteger(counts[key]) && counts[key] >= 0)
  );
}

function sameCounts(left, right) {
  return stableJson(left) === stableJson(right);
}

function validDigestContext(value) {
  return Boolean(value) && [value.databaseDigest, value.migrationCatalogDigest, value.schemaDigest].every((digestValue) => SHA256.test(digestValue ?? ""));
}

function validIsoTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function validDomainCounts(value) {
  return hasExactKeys(value, CLASSIFICATION_DOMAINS) && CLASSIFICATION_DOMAINS.every((domain) => Number.isSafeInteger(value[domain]) && value[domain] >= 0);
}

function validDomainDigests(value) {
  return hasExactKeys(value, CLASSIFICATION_DOMAINS) && CLASSIFICATION_DOMAINS.every((domain) => SHA256.test(value[domain] ?? ""));
}

function hasExactKeys(value, expectedKeys) {
  return Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    stableJson(Object.keys(value).sort()) === stableJson([...expectedKeys].sort());
}

function buildManifestRowDigests(rows, hashSalt) {
  return Object.fromEntries(
    CLASSIFICATION_DOMAINS.map((domain) => [
      domain,
      saltedDigest(`stage1-acceptance:row:${domain}:`, stableJson(rows[domain]), hashSalt)
    ])
  );
}

function stableCode(value) {
  return STABLE_ERROR_CODES.has(value) ? value : "STAGE1_ACCEPTANCE_ERROR";
}

function stableDomain(value) {
  return STABLE_EXCEPTION_DOMAINS.has(value) ? value : "unknown";
}

function fail(code) {
  throw new Error(code);
}
