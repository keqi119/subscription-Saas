import { createHash } from "node:crypto";

const ADMIN_USERNAME = "keqi_119";
const CUSTOMER_PHONE = "18616570212";
const SOURCE_DATABASE_NAME = "subscription_saas_staging";
const TARGET_DATABASE_NAME = /^subscription_saas_staging_acceptance_[a-z0-9_]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const IMAGE_REF = /^.+@sha256:[0-9a-f]{64}$/;
const REQUIRED_CONTRACT_TEMPLATE_TYPES = [
  "DELIVERY_HANDOVER",
  "SUBSCRIPTION_EXTENSION",
  "SUBSCRIPTION_STANDARD"
];
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
  "VEHICLE_SELECTION_REQUIRED",
  "WHITELIST_REFERENCE_NOT_CLOSED"
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
  if (
    source.hostname !== options.allowedHostname.toLowerCase() ||
    target.hostname !== options.allowedHostname.toLowerCase()
  ) {
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
  const catalog = classifyCatalog(snapshot.catalog, snapshot.vehicle, exceptions);
  const evaluationDate = acceptanceEvaluationDate(snapshot.evaluationDate ?? snapshot.asOf);
  const templates = classifyTemplates(
    snapshot.templates,
    snapshot.asOf,
    evaluationDate,
    exceptions
  );
  const vehicle = classifyVehicle(snapshot.vehicle, selection, catalog, evaluationDate, exceptions);
  const targetCountEvidence = copyTargetCountEvidence(snapshot.target);
  const targetForbiddenCounts = canonical(targetCountEvidence.forbiddenCounts ?? {});
  classifyTarget(snapshot.target, targetCountEvidence, exceptions);

  const rows = { access, customer, catalog, templates, vehicle };
  if (!whitelistReferencesClosed(rows)) {
    exception(exceptions, "WHITELIST_REFERENCE_NOT_CLOSED", "manifest", "whitelist-references");
  }
  const counts = Object.fromEntries(
    Object.entries(rows).map(([domain, value]) => [domain, countRows(value)])
  );
  const rowDigests = Object.fromEntries(
    Object.entries(rows).map(([domain, value]) => [
      domain,
      digest(`stage1-acceptance:rows:${domain}:`, stableJson(value))
    ])
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
      adminDigest: saltedDigest(
        "stage1-acceptance:admin:",
        selection.adminUsername,
        context.hashSalt
      ),
      customerDigest: saltedDigest(
        "stage1-acceptance:customer:",
        selection.customerPhone,
        context.hashSalt
      ),
      vehicleDigests: selection.vehicleIds
        .map((vehicleId) => saltedDigest("stage1-acceptance:vehicle:", vehicleId, context.hashSalt))
        .sort()
    },
    counts: classification.counts ?? {},
    rowDigests: buildManifestRowDigests(classification.rows, context.hashSalt),
    exceptions: array(classification.exceptions).map((value) =>
      redactException(value, context.hashSalt)
    ),
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
    sameCounts(
      classification.targetForbiddenCounts,
      classification.targetCountEvidence.forbiddenCounts
    ) &&
    allZero(classification.targetCountEvidence.forbiddenCounts) &&
    allZero(classification.targetCountEvidence.tableCounts)
  );
}

export function redactStage1CleanAcceptanceError(error) {
  const code =
    typeof error?.code === "string"
      ? error.code
      : typeof error?.message === "string"
        ? error.message
        : "STAGE1_ACCEPTANCE_ERROR";
  return { code: stableCode(code) };
}

function classifyAccess(access = {}, selection, exceptions) {
  const users = active(
    array(access.users).filter((row) => row.username === selection.adminUsername)
  );
  if (users.length === 0)
    exception(exceptions, "ADMIN_NOT_FOUND", "access", selection.adminUsername);
  if (users.length > 1) exception(exceptions, "ADMIN_AMBIGUOUS", "access", selection.adminUsername);
  const admin = users.length === 1 ? users[0] : undefined;
  const roles = active(array(access.roles));
  const permissions = active(array(access.permissions));
  const menus = active(array(access.menus));
  const roleIds = new Set(roles.map((row) => row.id));
  const permissionIds = new Set(permissions.map((row) => row.id));
  const menuIds = new Set(menus.map((row) => row.id));
  const userRoles = admin
    ? array(access.userRoles).filter(
        (row) => row?.deletedAt == null && row.userId === admin.id && roleIds.has(row.roleId)
      )
    : [];
  const assignedRoleIds = new Set(userRoles.map((row) => row.roleId));
  const assignedRoles = roles.filter((row) => assignedRoleIds.has(row.id));
  const adminRoleIds = new Set(
    assignedRoles.filter((row) => row.code === "ADMIN").map((row) => row.id)
  );
  const rolePermissions = array(access.rolePermissions).filter(
    (row) =>
      row?.deletedAt == null &&
      assignedRoleIds.has(row.roleId) &&
      permissionIds.has(row.permissionId)
  );
  const roleMenus = array(access.roleMenus).filter(
    (row) => row?.deletedAt == null && assignedRoleIds.has(row.roleId) && menuIds.has(row.menuId)
  );
  const grantedPermissionIds = new Set(
    rolePermissions.filter((row) => adminRoleIds.has(row.roleId)).map((row) => row.permissionId)
  );
  const grantedMenuIds = new Set(
    roleMenus.filter((row) => adminRoleIds.has(row.roleId)).map((row) => row.menuId)
  );
  const completeAdminAccess =
    adminRoleIds.size > 0 &&
    permissions.length > 0 &&
    menus.length > 0 &&
    permissions.every((row) => grantedPermissionIds.has(row.id)) &&
    menus.every((row) => grantedMenuIds.has(row.id)) &&
    completeMenuParentChains(menus);
  if (admin && !completeAdminAccess) {
    exception(exceptions, "ADMIN_ROLE_INCOMPLETE", "access", admin.id);
  }
  return sortRows({
    menus,
    permissions,
    roleMenus,
    rolePermissions,
    roles: assignedRoles,
    userRoles,
    users
  });
}

function classifyCustomer(customer = {}, selection, exceptions) {
  const accounts = array(customer.customerAccounts).filter(
    (row) =>
      row?.phone === selection.customerPhone &&
      row.deletedAt == null &&
      row.accountStatus === "ACTIVE"
  );
  if (accounts.length === 0)
    exception(exceptions, "CUSTOMER_NOT_FOUND", "customer", selection.customerPhone);
  if (accounts.length > 1)
    exception(exceptions, "CUSTOMER_AMBIGUOUS", "customer", selection.customerPhone);
  const account = accounts.length === 1 ? accounts[0] : undefined;
  const customers = account
    ? active(array(customer.customers).filter((row) => row.id === account.customerId))
    : [];
  if (account && customers.length !== 1)
    exception(
      exceptions,
      customers.length === 0 ? "CUSTOMER_NOT_FOUND" : "CUSTOMER_AMBIGUOUS",
      "customer",
      account.customerId
    );
  const customerId = customers[0]?.id;
  const identities = array(customer.customerIdentities).filter(
    (row) => row?.customerId === customerId && row.deletedAt == null
  );
  const profiles = array(customer.customerProfiles).filter(
    (row) => row?.customerId === customerId && row.deletedAt == null
  );
  const eSignAccounts = array(customer.customerESignProviderAccounts).filter(
    (row) => row?.customerId === customerId && validCustomerESignAccount(row)
  );
  if (
    customerId &&
    (identities.length !== 1 || profiles.length !== 1 || eSignAccounts.length !== 1)
  ) {
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

function classifyCatalog(catalog = {}, vehicle = {}, exceptions) {
  const products = active(array(catalog.products));
  const productVersions = active(array(catalog.productVersions));
  const depositRules = active(array(catalog.depositRules));
  const vehiclePackages = active(array(catalog.vehiclePackages));
  const vehiclePackageModelMembers = array(catalog.vehiclePackageModelMembers);
  const mileagePackages = active(array(catalog.mileagePackages));
  const energyPackages = active(array(catalog.energyPackages));
  const benefitPackages = active(array(catalog.benefitPackages));
  const subscriptionPlans = active(array(catalog.subscriptionPlans));
  const productPriceRules = active(array(catalog.productPriceRules));
  const vehicleModelDefinitions = array(vehicle.vehicleModelDefinitions);
  if (
    products.length === 0 ||
    productVersions.length === 0 ||
    depositRules.length === 0 ||
    vehiclePackages.length === 0 ||
    subscriptionPlans.length === 0
  ) {
    exception(exceptions, "CATALOG_ACTIVE_SET_EMPTY", "catalog", "active");
  }
  const byId = (rows, id) => rows.filter((row) => row.id === id).length === 1;
  const closesProductVersion = (row) => byId(products, row.productId);
  const closesProductVersionBoundRow = (row) =>
    byId(products, row.productId) && byId(productVersions, row.productVersionId);
  const closesVehicleModel = (row) =>
    nonEmpty(row.modelDefinitionId) &&
    vehicleModelDefinitions.filter(
      (model) => model?.id === row.modelDefinitionId && usableVehicleModelDefinition(model)
    ).length === 1;
  const closed =
    productVersions.every(closesProductVersion) &&
    vehiclePackages.every((row) => closesProductVersionBoundRow(row) && closesVehicleModel(row)) &&
    vehiclePackageModelMembers.every(
      (row) => byId(vehiclePackages, row.vehiclePackageId) && closesVehicleModel(row)
    ) &&
    mileagePackages.every(closesProductVersionBoundRow) &&
    energyPackages.every(closesProductVersionBoundRow) &&
    benefitPackages.every(closesProductVersionBoundRow) &&
    productPriceRules.every(
      (row) => byId(productVersions, row.productVersionId) && closesVehicleModel(row)
    ) &&
    subscriptionPlans.every(
      (row) =>
        byId(products, row.productId) &&
        byId(productVersions, row.productVersionId) &&
        byId(vehiclePackages, row.vehiclePackageId) &&
        byId(mileagePackages, row.mileagePackageId) &&
        byId(energyPackages, row.energyPackageId) &&
        (row.benefitPackageId === null || byId(benefitPackages, row.benefitPackageId))
    );
  if (!closed) exception(exceptions, "CATALOG_REFERENCE_NOT_CLOSED", "catalog", "references");
  return sortRows({
    benefitPackages,
    depositRules,
    energyPackages,
    mileagePackages,
    productPriceRules,
    productVersions,
    products,
    subscriptionPlans,
    vehiclePackageModelMembers,
    vehiclePackages
  });
}

function classifyTemplates(templates = {}, snapshotAsOf, evaluationDate, exceptions) {
  const contractVersions = array(templates.contractVersions);
  const allFileObjects = array(templates.fileObjects);
  const notificationTemplates = array(templates.notificationTemplates).filter(
    (row) => row?.deletedAt === null && row.templateStatus === "ACTIVE"
  );
  const requiredContractTypes = requiredCodes(templates.requiredContractTemplateTypes);
  const requiredNotificationCodes = requiredCodes(templates.requiredNotificationTemplateCodes);
  const selectedContractVersions = [];
  const selectedFiles = [];
  const selectedNotifications = [];
  const hasRequiredContractTypes = sameStringSet(
    requiredContractTypes,
    REQUIRED_CONTRACT_TEMPLATE_TYPES
  );
  const asOfTime = validDate(snapshotAsOf) ? snapshotAsOf.getTime() : undefined;
  if (!hasRequiredContractTypes) {
    exception(
      exceptions,
      "CONTRACT_TEMPLATE_REQUIRED",
      "templates",
      "required-contract-template-types"
    );
  }
  if (asOfTime === undefined) {
    exception(exceptions, "CONTRACT_TEMPLATE_REQUIRED", "templates", "snapshot-as-of");
  }
  if (requiredNotificationCodes.length === 0) {
    exception(
      exceptions,
      "NOTIFICATION_TEMPLATE_REQUIRED",
      "templates",
      "required-notification-codes"
    );
  }
  for (const templateType of hasRequiredContractTypes && asOfTime !== undefined
    ? requiredContractTypes
    : []) {
    const versions = contractVersions.filter(
      (row) =>
        row.templateType === templateType && usableContractVersion(row, asOfTime, evaluationDate)
    );
    if (versions.length !== 1) {
      exception(
        exceptions,
        versions.length > 1 ? "CONTRACT_TEMPLATE_AMBIGUOUS" : "CONTRACT_TEMPLATE_REQUIRED",
        "templates",
        templateType
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
    pushUniqueRow(selectedFiles, files[0]);
  }
  for (const code of requiredNotificationCodes) {
    const notifications = notificationTemplates.filter((row) => row.templateCode === code);
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

function classifyVehicle(vehicle = {}, selection, catalog, evaluationDate, exceptions) {
  const closure = {
    assetOwners: [],
    vehicleAssetCostProfiles: [],
    vehicleCostLedgerEntries: [],
    vehicleDocumentBatches: [],
    vehicleDocuments: [],
    vehicleInsuranceCoverages: [],
    vehicleInsurancePolicies: [],
    vehicleListingMedia: [],
    vehicleListingPlans: [],
    vehicleListingProfiles: [],
    vehicleListingSourceBindings: [],
    vehicleModelDefinitions: [],
    vehicleOwnershipPeriods: [],
    vehicleSalePriceHistories: [],
    vehicles: []
  };
  const allVehicleModelDefinitions = array(vehicle.vehicleModelDefinitions);
  for (const modelDefinitionId of catalogModelDefinitionIds(catalog)) {
    const matches = allVehicleModelDefinitions.filter(
      (row) => row?.id === modelDefinitionId && usableVehicleModelDefinition(row)
    );
    if (matches.length === 1) pushUniqueRow(closure.vehicleModelDefinitions, matches[0]);
  }
  if (selection.vehicleIds.length === 0) {
    exception(exceptions, "VEHICLE_SELECTION_REQUIRED", "vehicle", "selection");
    return sortRows(closure);
  }
  const vehicles = array(vehicle.vehicles);
  const allInsurancePolicies = array(vehicle.vehicleInsurancePolicies);
  const allInsuranceCoverages = array(vehicle.vehicleInsuranceCoverages);
  const insuranceCoverageReferencesClosed = allInsuranceCoverages.every(
    (coverage) =>
      allInsurancePolicies.filter((policy) => policy.id === coverage?.policyId).length === 1
  );
  for (const vehicleId of selection.vehicleIds) {
    const matches = vehicles.filter((row) => row?.id === vehicleId);
    const evidence = vehicle.eligibilityEvidence?.[vehicleId];
    if (matches.length !== 1 || !eligibleVehicle(matches[0], evidence)) {
      exception(exceptions, "VEHICLE_NOT_ELIGIBLE", "vehicle", vehicleId);
      continue;
    }
    const item = matches[0];
    const currentOwnershipPeriods = rowsForVehicle(vehicle.vehicleOwnershipPeriods, item.id).filter(
      (row) => row?.endedAt === null
    );
    const currentOwnership =
      currentOwnershipPeriods.length === 1 ? currentOwnershipPeriods[0] : undefined;
    const owners = currentOwnership
      ? array(vehicle.assetOwners).filter(
          (row) => row?.id === currentOwnership.assetOwnerId && row.status === "ACTIVE"
        )
      : [];
    const models = allVehicleModelDefinitions.filter(
      (row) => row?.id === item.modelDefinitionId && usableVehicleModelDefinition(row)
    );
    const profiles = array(vehicle.vehicleListingProfiles).filter(
      (row) =>
        row?.vehicleId === item.id &&
        row.deletedAt == null &&
        row.listingStatus === "PUBLISHED" &&
        row.portalVisible === true
    );
    if (
      currentOwnershipPeriods.length !== 1 ||
      owners.length !== 1 ||
      models.length !== 1 ||
      profiles.length !== 1
    ) {
      exception(exceptions, "VEHICLE_REFERENCE_NOT_CLOSED", "vehicle", item.id);
      continue;
    }
    const profile = profiles[0];
    const documentBatches = rowsForVehicle(vehicle.vehicleDocumentBatches, item.id);
    const insurancePolicies = rowsForVehicle(allInsurancePolicies, item.id);
    const insurancePolicyIds = new Set(insurancePolicies.map(({ id }) => id));
    const listingMedia = rowsForVehicle(vehicle.vehicleListingMedia, item.id);
    const listingPlans = rowsForVehicle(vehicle.vehicleListingPlans, item.id);
    const documents = rowsForVehicle(vehicle.vehicleDocuments, item.id);
    const sourceBindings = rowsForVehicle(vehicle.vehicleListingSourceBindings, item.id);
    const coverages = allInsuranceCoverages.filter((row) => insurancePolicyIds.has(row?.policyId));
    const currentPolicies = insurancePolicies.filter(
      (row) =>
        row?.deletedAt === null &&
        row.policyStatus === "ACTIVE" &&
        dateWindowIncludes(row, evaluationDate)
    );
    const compulsoryPolicies = currentPolicies.filter(
      (row) => row.policyType === "COMPULSORY_TRAFFIC"
    );
    const commercialPolicies = currentPolicies.filter((row) => row.policyType === "COMMERCIAL");
    const selectedPolicyIds = new Set(currentPolicies.map(({ id }) => id));
    const selectedCoverages = coverages.filter(
      (row) => row?.deletedAt === null && selectedPolicyIds.has(row.policyId)
    );
    const currentLicenses = documents.filter(
      (row) =>
        row?.deletedAt === null &&
        row.documentStatus === "ACTIVE" &&
        row.documentType === "VEHICLE_LICENSE" &&
        row.customerVisible === true &&
        nullableDateWindowIncludes(row, evaluationDate)
    );
    const currentSalePrices = rowsForVehicle(vehicle.vehicleSalePriceHistories, item.id).filter(
      (row) => dateWindowIncludes(row, evaluationDate)
    );
    const catalogPlans = array(catalog?.subscriptionPlans);
    const retainedListingPlans = listingPlans.filter(
      (row) =>
        row?.deletedAt === null &&
        row.visible === true &&
        row.listingProfileId === profile.id &&
        catalogPlans.some(
          (plan) =>
            plan.id === row.subscriptionPlanId &&
            catalogPlanSupportsModel(plan, item.modelDefinitionId, catalog)
        )
    );
    const referencedBatchIds = new Set(
      documents.map(({ batchId }) => batchId).filter((id) => typeof id === "string")
    );
    if (
      !listingMedia.every(
        (row) =>
          row?.deletedAt === null &&
          row.customerVisible === true &&
          row.listingProfileId === profile.id
      ) ||
      listingPlans.length === 0 ||
      retainedListingPlans.length !== listingPlans.length ||
      currentPolicies.length !== 2 ||
      compulsoryPolicies.length !== 1 ||
      commercialPolicies.length !== 1 ||
      selectedCoverages.length !== coverages.length ||
      compulsoryPolicies.some(
        (policy) => !selectedCoverages.some((coverage) => coverage.policyId === policy.id)
      ) ||
      commercialPolicies.some(
        (policy) => !selectedCoverages.some((coverage) => coverage.policyId === policy.id)
      ) ||
      currentLicenses.length !== 1 ||
      !documents.every(
        (row) =>
          row?.deletedAt === null &&
          row.documentStatus === "ACTIVE" &&
          row.customerVisible === true &&
          nullableDateWindowIncludes(row, evaluationDate)
      ) ||
      !documents.every(
        (row) =>
          (row.batchId === null ||
            documentBatches.filter((batch) => batch.id === row.batchId).length === 1) &&
          (row.policyId === null ||
            insurancePolicies.filter((policy) => policy.id === row.policyId).length === 1)
      ) ||
      !sourceBindings.every(
        (binding) => documents.filter((document) => document.id === binding.documentId).length === 1
      ) ||
      !documentBatches.every((batch) => referencedBatchIds.has(batch.id)) ||
      currentSalePrices.length !== 1 ||
      currentSalePrices.length !==
        rowsForVehicle(vehicle.vehicleSalePriceHistories, item.id).length ||
      currentSalePrices[0]?.afterSalePriceAmount !== item.currentSalePriceAmount ||
      !insuranceCoverageReferencesClosed
    ) {
      exception(exceptions, "VEHICLE_REFERENCE_NOT_CLOSED", "vehicle", item.id);
      continue;
    }
    closure.vehicles.push(item);
    pushUniqueRow(closure.assetOwners, owners[0]);
    pushUniqueRow(closure.vehicleModelDefinitions, models[0]);
    closure.vehicleListingProfiles.push(profile);
    closure.vehicleListingMedia.push(...listingMedia);
    closure.vehicleListingPlans.push(...listingPlans);
    closure.vehicleDocumentBatches.push(...documentBatches);
    closure.vehicleDocuments.push(...documents);
    closure.vehicleListingSourceBindings.push(...sourceBindings);
    closure.vehicleInsurancePolicies.push(...insurancePolicies);
    closure.vehicleInsuranceCoverages.push(...coverages);
    closure.vehicleSalePriceHistories.push(...currentSalePrices);
    closure.vehicleOwnershipPeriods.push(currentOwnership);
    closure.vehicleAssetCostProfiles.push(
      ...rowsForVehicle(vehicle.vehicleAssetCostProfiles, item.id)
    );
    closure.vehicleCostLedgerEntries.push(
      ...rowsForVehicle(vehicle.vehicleCostLedgerEntries, item.id)
    );
  }
  return sortRows(closure);
}

function classifyTarget(target = {}, countEvidence, exceptions) {
  if (target.schemaCanonical !== true)
    exception(exceptions, "TARGET_SCHEMA_NOT_CANONICAL", "target", "schema");
  if (!validTargetCountEvidence(countEvidence)) {
    exception(exceptions, "TARGET_COUNT_EVIDENCE_INVALID", "target", "counts");
    return;
  }
  if (!allZero(countEvidence.tableCounts))
    exception(exceptions, "TARGET_NOT_EMPTY", "target", "rows");
  if (!allZero(countEvidence.forbiddenCounts))
    exception(exceptions, "FORBIDDEN_DOMAIN_NOT_EMPTY", "target", "forbidden");
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
  )
    fail("MANIFEST_CONTEXT_INVALID");
}

function requireClassification(classification) {
  if (
    !classification ||
    typeof classification !== "object" ||
    typeof classification.safeToApply !== "boolean"
  ) {
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
  if (
    !validDomainCounts(classification.counts) ||
    !validDomainDigests(classification.rowDigests) ||
    !Array.isArray(classification.exceptions)
  ) {
    fail("MANIFEST_CLASSIFICATION_INVALID");
  }
  if (
    !validTargetCountEvidence(classification.targetCountEvidence) ||
    !sameCounts(
      classification.targetForbiddenCounts,
      classification.targetCountEvidence.forbiddenCounts
    )
  ) {
    fail("MANIFEST_CLASSIFICATION_INVALID");
  }
  if (classification.safeToApply && !isStage1CleanAcceptanceBaselineSafe(classification)) {
    fail("MANIFEST_CLASSIFICATION_INVALID");
  }
}

function redactException(value, hashSalt) {
  const code = stableCode(value?.code);
  const domain = stableDomain(value?.domain);
  const sourceDigest = SHA256.test(value?.subjectDigest ?? "")
    ? value.subjectDigest
    : digest("stage1-acceptance:exception:unknown:", "invalid");
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

function completeMenuParentChains(menus) {
  const byId = new Map();
  for (const menu of menus) {
    if (!nonEmpty(menu?.id) || byId.has(menu.id)) return false;
    byId.set(menu.id, menu);
  }
  for (const menu of menus) {
    const visited = new Set([menu.id]);
    let current = menu;
    while (current.parentId != null) {
      if (!nonEmpty(current.parentId) || visited.has(current.parentId)) return false;
      const parent = byId.get(current.parentId);
      if (!parent) return false;
      visited.add(parent.id);
      current = parent;
    }
  }
  return true;
}

function whitelistReferencesClosed(rows) {
  const { access, customer, catalog, templates, vehicle } = rows;
  const one = (items, id) =>
    nonEmpty(id) && array(items).filter((row) => row?.id === id).length === 1;
  const optional = (items, id) => id == null || one(items, id);
  const every = (items, predicate) => array(items).every(predicate);

  return (
    every(access.menus, (row) => optional(access.menus, row.parentId)) &&
    every(
      access.rolePermissions,
      (row) => one(access.roles, row.roleId) && one(access.permissions, row.permissionId)
    ) &&
    every(
      access.roleMenus,
      (row) => one(access.roles, row.roleId) && one(access.menus, row.menuId)
    ) &&
    every(
      access.userRoles,
      (row) => one(access.users, row.userId) && one(access.roles, row.roleId)
    ) &&
    every(customer.customers, (row) => optional(access.users, row.ownerUserId)) &&
    every(customer.customerAccounts, (row) => one(customer.customers, row.customerId)) &&
    every(customer.customerIdentities, (row) => one(customer.customers, row.customerId)) &&
    every(customer.customerProfiles, (row) => one(customer.customers, row.customerId)) &&
    every(customer.customerESignProviderAccounts, (row) =>
      one(customer.customers, row.customerId)
    ) &&
    every(
      catalog.productVersions,
      (row) => one(catalog.products, row.productId) && optional(access.users, row.approvedBy)
    ) &&
    every(
      catalog.vehiclePackages,
      (row) =>
        one(catalog.products, row.productId) &&
        one(catalog.productVersions, row.productVersionId) &&
        one(vehicle.vehicleModelDefinitions, row.modelDefinitionId)
    ) &&
    every(
      catalog.vehiclePackageModelMembers,
      (row) =>
        one(catalog.vehiclePackages, row.vehiclePackageId) &&
        one(vehicle.vehicleModelDefinitions, row.modelDefinitionId)
    ) &&
    every(
      catalog.mileagePackages,
      (row) =>
        one(catalog.products, row.productId) && one(catalog.productVersions, row.productVersionId)
    ) &&
    every(
      catalog.energyPackages,
      (row) =>
        one(catalog.products, row.productId) && one(catalog.productVersions, row.productVersionId)
    ) &&
    every(
      catalog.benefitPackages,
      (row) =>
        one(catalog.products, row.productId) && one(catalog.productVersions, row.productVersionId)
    ) &&
    every(
      catalog.subscriptionPlans,
      (row) =>
        one(catalog.products, row.productId) &&
        one(catalog.productVersions, row.productVersionId) &&
        one(catalog.vehiclePackages, row.vehiclePackageId) &&
        one(catalog.mileagePackages, row.mileagePackageId) &&
        one(catalog.energyPackages, row.energyPackageId) &&
        optional(catalog.benefitPackages, row.benefitPackageId)
    ) &&
    every(
      catalog.productPriceRules,
      (row) =>
        one(catalog.productVersions, row.productVersionId) &&
        one(vehicle.vehicleModelDefinitions, row.modelDefinitionId)
    ) &&
    every(templates.fileObjects, (row) => optional(access.users, row.uploadedBy)) &&
    every(
      templates.contractVersions,
      (row) => one(templates.fileObjects, row.fileId) && optional(access.users, row.approvedBy)
    ) &&
    every(
      vehicle.assetOwners,
      (row) => optional(access.users, row.createdBy) && optional(access.users, row.updatedBy)
    ) &&
    every(vehicle.vehicles, (row) => one(vehicle.vehicleModelDefinitions, row.modelDefinitionId)) &&
    every(vehicle.vehicleListingProfiles, (row) => one(vehicle.vehicles, row.vehicleId)) &&
    every(
      vehicle.vehicleListingMedia,
      (row) =>
        one(vehicle.vehicles, row.vehicleId) &&
        optional(vehicle.vehicleListingProfiles, row.listingProfileId)
    ) &&
    every(
      vehicle.vehicleListingPlans,
      (row) =>
        one(vehicle.vehicles, row.vehicleId) &&
        optional(vehicle.vehicleListingProfiles, row.listingProfileId) &&
        one(catalog.subscriptionPlans, row.subscriptionPlanId)
    ) &&
    every(vehicle.vehicleDocumentBatches, (row) => one(vehicle.vehicles, row.vehicleId)) &&
    every(vehicle.vehicleInsurancePolicies, (row) => one(vehicle.vehicles, row.vehicleId)) &&
    every(
      vehicle.vehicleDocuments,
      (row) =>
        one(vehicle.vehicles, row.vehicleId) &&
        optional(vehicle.vehicleDocumentBatches, row.batchId) &&
        optional(vehicle.vehicleInsurancePolicies, row.policyId)
    ) &&
    every(vehicle.vehicleInsuranceCoverages, (row) =>
      one(vehicle.vehicleInsurancePolicies, row.policyId)
    ) &&
    every(
      vehicle.vehicleListingSourceBindings,
      (row) => one(vehicle.vehicles, row.vehicleId) && one(vehicle.vehicleDocuments, row.documentId)
    ) &&
    every(vehicle.vehicleSalePriceHistories, (row) => one(vehicle.vehicles, row.vehicleId)) &&
    every(
      vehicle.vehicleOwnershipPeriods,
      (row) =>
        one(vehicle.vehicles, row.vehicleId) &&
        one(vehicle.assetOwners, row.assetOwnerId) &&
        optional(access.users, row.startConfirmedBy) &&
        optional(access.users, row.endConfirmedBy) &&
        optional(access.users, row.createdBy)
    ) &&
    every(vehicle.vehicleAssetCostProfiles, (row) => one(vehicle.vehicles, row.vehicleId)) &&
    every(
      vehicle.vehicleCostLedgerEntries,
      (row) =>
        one(vehicle.vehicles, row.vehicleId) &&
        row.orderId == null &&
        row.contractId == null &&
        optional(customer.customers, row.customerId) &&
        optional(vehicle.assetOwners, row.assetOwnerId) &&
        row.workOrderId == null &&
        row.evidenceId == null &&
        one(access.users, row.confirmedBy) &&
        optional(vehicle.vehicleCostLedgerEntries, row.reversalOfEntryId)
    )
  );
}

function catalogModelDefinitionIds(catalog = {}) {
  return [
    ...new Set(
      [
        ...array(catalog.vehiclePackages).map((row) => row?.modelDefinitionId),
        ...array(catalog.vehiclePackageModelMembers).map((row) => row?.modelDefinitionId),
        ...array(catalog.productPriceRules).map((row) => row?.modelDefinitionId)
      ].filter(nonEmpty)
    )
  ].sort();
}

function usableVehicleModelDefinition(row) {
  return row?.deletedAt == null && row.enabled === true && row.portalVisible === true;
}

function sortRows(value) {
  if (Array.isArray(value)) return [...value].sort(compareBusinessRow);
  return Object.fromEntries(Object.entries(value).map(([key, rows]) => [key, sortRows(rows)]));
}

function countRows(value) {
  return Array.isArray(value)
    ? value.length
    : Object.values(value).reduce((total, rows) => total + countRows(rows), 0);
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
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])])
    );
  }
  if (typeof value === "bigint") return value.toString();
  return value;
}

function compareValue(left, right) {
  return stableJson(left).localeCompare(stableJson(right));
}

function compareException(left, right) {
  return `${left.code}|${left.domain}|${left.subjectDigest}`.localeCompare(
    `${right.code}|${right.domain}|${right.subjectDigest}`
  );
}

function compareBusinessRow(left, right) {
  const leftKey = businessKey(left);
  const rightKey = businessKey(right);
  return leftKey.localeCompare(rightKey) || compareValue(left, right);
}

function businessKey(row) {
  if (!row || typeof row !== "object") return stableJson(row);
  for (const key of [
    "id",
    "code",
    "username",
    "phone",
    "templateCode",
    "vehicleId",
    "roleId",
    "permissionId",
    "menuId"
  ]) {
    if (typeof row[key] === "string") return `${key}:${row[key]}`;
  }
  return stableJson(row);
}

function allZero(counts) {
  return (
    validCountMap(counts, Object.keys(counts)) &&
    Object.values(counts).every((count) => count === 0)
  );
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
  if (!Array.isArray(value) || value.length === 0 || value.some((code) => !nonEmpty(code)))
    return [];
  return [...new Set(value)].sort();
}

function sameStringSet(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validDate(value) {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function usableContractVersion(row, asOfTime, evaluationDate) {
  if (
    !row ||
    row.businessType !== "SUBSCRIPTION" ||
    row.status !== "ACTIVE" ||
    row.deletedAt !== null ||
    !nonEmpty(row.approvedBy) ||
    !validDate(row.approvedAt) ||
    !validDate(row.effectiveFrom) ||
    (row.effectiveTo !== null && !validDate(row.effectiveTo))
  ) {
    return false;
  }
  return row.approvedAt.getTime() <= asOfTime && dateWindowIncludes(row, evaluationDate);
}

function validPdfFile(file) {
  return (
    Boolean(file) &&
    nonEmpty(file.id) &&
    nonEmpty(file.bucket) &&
    nonEmpty(file.objectKey) &&
    nonEmpty(file.originalName) &&
    typeof file.mimeType === "string" &&
    file.mimeType.toLowerCase().split(";", 1)[0].trim() === "application/pdf" &&
    positive(file.sizeBytes) &&
    SHA256.test(file.contentSha256 ?? "")
  );
}

function validCustomerESignAccount(row) {
  return (
    row?.deletedAt == null &&
    row.registrationStatus === "REGISTERED" &&
    row.realNameStatus === "VERIFIED" &&
    row.certBindingStatus === "BOUND" &&
    (nonEmpty(row.providerOpenId) || nonEmpty(row.providerCustomerId))
  );
}

function eligibleVehicle(vehicle, evidence) {
  return (
    vehicle?.deletedAt == null &&
    vehicle.status === "AVAILABLE" &&
    vehicle.currentSalePriceAmount > 0 &&
    vehicle.salePriceStatus === "EFFECTIVE" &&
    evidence?.activeApplicationCount === 0 &&
    evidence?.activeAssetWorkOrderCount === 0 &&
    evidence?.activeReviewReservationCount === 0 &&
    evidence?.activeServiceCaseCount === 0 &&
    evidence?.blockingRestrictionCount === 0 &&
    evidence?.overlappingSubscriptionPeriodCount === 0 &&
    evidence?.currentCommercialPolicyCount === 1 &&
    evidence?.currentCompulsoryTrafficPolicyCount === 1 &&
    evidence?.currentLicenseCount === 1 &&
    evidence?.deliveryCount === 0 &&
    evidence?.orderCount === 0 &&
    evidence?.requiredDocumentsAndInsuranceReady === true &&
    evidence?.returnCount === 0 &&
    evidence?.currentSalePricePositive === true &&
    evidence?.salePriceStatusEffective === true &&
    evidence?.visibleRetainedListingPlanCount > 0
  );
}

function acceptanceEvaluationDate(value) {
  if (!validDate(value)) return undefined;
  return new Date(`${value.toISOString().slice(0, 10)}T00:00:00.000Z`);
}

function dateWindowIncludes(row, evaluationDate) {
  return (
    validDate(evaluationDate) &&
    validDate(row?.effectiveFrom) &&
    row.effectiveFrom.getTime() <= evaluationDate.getTime() &&
    (row.effectiveTo === null ||
      (validDate(row.effectiveTo) && row.effectiveTo.getTime() >= evaluationDate.getTime()))
  );
}

function nullableDateWindowIncludes(row, evaluationDate) {
  return (
    validDate(evaluationDate) &&
    (row?.effectiveFrom === null ||
      (validDate(row?.effectiveFrom) && row.effectiveFrom.getTime() <= evaluationDate.getTime())) &&
    (row?.effectiveTo === null ||
      (validDate(row?.effectiveTo) && row.effectiveTo.getTime() >= evaluationDate.getTime()))
  );
}

function catalogPlanSupportsModel(plan, modelDefinitionId, catalog) {
  const packages = array(catalog?.vehiclePackages).filter(
    (item) => item.id === plan?.vehiclePackageId
  );
  if (packages.length !== 1) return false;
  return (
    packages[0].modelDefinitionId === modelDefinitionId ||
    array(catalog?.vehiclePackageModelMembers).some(
      (member) =>
        member.vehiclePackageId === packages[0].id && member.modelDefinitionId === modelDefinitionId
    )
  );
}

function rowsForVehicle(rows, vehicleId) {
  return array(rows).filter((row) => row?.vehicleId === vehicleId);
}

function pushUniqueRow(rows, row) {
  if (!rows.some((item) => item.id === row.id)) rows.push(row);
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
  return (
    Boolean(value) &&
    validCountMap(value.forbiddenCounts, value.forbiddenCountKeys) &&
    validCountMap(value.tableCounts, value.tableCountKeys)
  );
}

function validCountMap(counts, countKeys) {
  if (
    !counts ||
    typeof counts !== "object" ||
    Array.isArray(counts) ||
    !Array.isArray(countKeys) ||
    countKeys.length === 0
  )
    return false;
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
  return (
    Boolean(value) &&
    [value.databaseDigest, value.migrationCatalogDigest, value.schemaDigest].every((digestValue) =>
      SHA256.test(digestValue ?? "")
    )
  );
}

function validIsoTimestamp(value) {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function validDomainCounts(value) {
  return (
    hasExactKeys(value, CLASSIFICATION_DOMAINS) &&
    CLASSIFICATION_DOMAINS.every(
      (domain) => Number.isSafeInteger(value[domain]) && value[domain] >= 0
    )
  );
}

function validDomainDigests(value) {
  return (
    hasExactKeys(value, CLASSIFICATION_DOMAINS) &&
    CLASSIFICATION_DOMAINS.every((domain) => SHA256.test(value[domain] ?? ""))
  );
}

function hasExactKeys(value, expectedKeys) {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    stableJson(Object.keys(value).sort()) === stableJson([...expectedKeys].sort())
  );
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
