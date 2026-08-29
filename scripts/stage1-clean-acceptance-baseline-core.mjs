import { createHash } from "node:crypto";

const ADMIN_USERNAME = "keqi_119";
const CUSTOMER_PHONE = "18616570212";
const SOURCE_DATABASE_NAME = "subscription_saas_staging";
const TARGET_DATABASE_NAME = /^subscription_saas_staging_acceptance_[a-z0-9_]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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
  const targetForbiddenCounts = canonical(snapshot.target?.forbiddenCounts ?? {});
  classifyTarget(snapshot.target, targetForbiddenCounts, exceptions);

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
    targetForbiddenCounts
  };
}

export function buildStage1CleanAcceptanceManifest(classification, context = {}) {
  requireContext(context);
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
    rowDigests: classification.rowDigests ?? {},
    exceptions: array(classification.exceptions).map(redactException),
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
    allZero(classification.targetForbiddenCounts ?? {})
  );
}

export function redactStage1CleanAcceptanceError(error) {
  const code = typeof error?.code === "string" ? error.code : typeof error?.message === "string" ? error.message : "STAGE1_ACCEPTANCE_ERROR";
  return { code: /^[A-Z0-9_]+$/.test(code) ? code : "STAGE1_ACCEPTANCE_ERROR" };
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
  const fileObjects = array(templates.fileObjects);
  const notificationTemplates = active(array(templates.notificationTemplates));
  const duplicate = new Set();
  for (const row of contractVersions) {
    if (duplicate.has(row.templateCode)) exception(exceptions, "CONTRACT_TEMPLATE_AMBIGUOUS", "templates", row.templateCode);
    duplicate.add(row.templateCode);
    const file = fileObjects.find((item) => item.id === row.fileId);
    if (!file || file.mimeType !== "application/pdf" || !nonEmpty(file.objectKey) || !positive(file.sizeBytes)) {
      exception(exceptions, "CONTRACT_TEMPLATE_FILE_INVALID", "templates", row.id);
    }
  }
  return sortRows({ contractVersions, fileObjects: fileObjects.filter((file) => contractVersions.some((row) => row.fileId === file.id)), notificationTemplates });
}

function classifyVehicle(vehicle = {}, selection, exceptions) {
  if (selection.vehicleIds.length === 0) {
    exception(exceptions, "VEHICLE_SELECTION_REQUIRED", "vehicle", "selection");
    return [];
  }
  const vehicles = array(vehicle.vehicles);
  const selected = [];
  for (const vehicleId of selection.vehicleIds) {
    const item = vehicles.find((row) => row.id === vehicleId);
    if (!item || item.status !== "AVAILABLE" || item.deletedAt != null) {
      exception(exceptions, "VEHICLE_NOT_ELIGIBLE", "vehicle", vehicleId);
      continue;
    }
    const owner = active(array(vehicle.assetOwners)).find((row) => row.id === item.assetOwnerId);
    const model = active(array(vehicle.vehicleModelDefinitions)).find((row) => row.id === item.vehicleModelDefinitionId);
    const profile = active(array(vehicle.vehicleListingProfiles)).find((row) => row.id === item.listingProfileId && row.vehicleId === item.id);
    if (!owner || !model || !profile) exception(exceptions, "VEHICLE_REFERENCE_NOT_CLOSED", "vehicle", item.id);
    selected.push(item);
  }
  return sortRows(selected);
}

function classifyTarget(target = {}, forbiddenCounts, exceptions) {
  if (target.schemaCanonical !== true) exception(exceptions, "TARGET_SCHEMA_NOT_CANONICAL", "target", "schema");
  if (!allZero(target.tableCounts ?? {})) exception(exceptions, "TARGET_NOT_EMPTY", "target", "rows");
  if (!allZero(forbiddenCounts)) exception(exceptions, "FORBIDDEN_DOMAIN_NOT_EMPTY", "target", "forbidden");
}

function digestContext(context) {
  return {
    databaseDigest: context?.databaseDigest ?? "",
    migrationCatalogDigest: context?.migrationCatalogDigest ?? "",
    schemaDigest: context?.schemaDigest ?? ""
  };
}

function requireContext(context) {
  if (!nonEmpty(context.gitSha) || !nonEmpty(context.imageRef) || !nonEmpty(context.generatedAt) || !nonEmpty(context.hashSalt)) {
    fail("MANIFEST_CONTEXT_INVALID");
  }
  if (!context.source || !context.target) fail("MANIFEST_CONTEXT_INVALID");
}

function redactException(value) {
  return {
    code: typeof value?.code === "string" ? value.code : "STAGE1_ACCEPTANCE_ERROR",
    domain: typeof value?.domain === "string" ? value.domain : "unknown",
    subjectDigest: typeof value?.subjectDigest === "string" ? value.subjectDigest : digest("stage1-acceptance:subject:", "unknown")
  };
}

function exception(exceptions, code, domain, subject) {
  exceptions.push({ code, domain, subjectDigest: digest(`stage1-acceptance:${domain}:`, String(subject)) });
}

function active(rows) {
  return rows.filter((row) => row && row.deletedAt == null && row.status !== "INACTIVE" && row.status !== "DISABLED");
}

function sortRows(value) {
  if (Array.isArray(value)) return [...value].sort(compareValue);
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

function allZero(counts) {
  return Object.values(counts).every((count) => count === 0);
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

function fail(code) {
  throw new Error(code);
}
