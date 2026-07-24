import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";

config({ path: "../../.env" });
config({ path: ".env" });

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for seed baseline verification.");
}

const prisma = new PrismaClient({
  adapter: new PrismaPg(normalizeLocalhostDatabaseUrl(databaseUrl))
});

const seedVehicleVins = ["TESTVINET50000001", "TESTVINET70000001", "TESTVINES60000001"];
const seedCustomerNos = [
  "CUS-SEED-LEAD-A-001",
  "CUS-SEED-LEAD-B-001",
  "CUS-SEED-LEAD-C-001",
  "CUS-SEED-LEAD-COMPANY-001"
];

const baselineCatalog = {
  benefitPackageNo: "BPK-AUTO-ET5-WASH",
  energyPackageNo: "EPK-AUTO-ET5-POWER",
  mileagePackageNo: "MPK-AUTO-ET5-1500",
  planNo: "PLAN-AUTO-ET5-STANDARD",
  productNo: "PROD-AUTO-ET5",
  vehiclePackageNo: "VPK-AUTO-ET5-STANDARD",
  versionNo: "2026-AUTO-REVIEW"
};

const oldDefaultFlowSeedData = {
  applicationNos: [
    "APP-AUTO-REVIEW-ET5-001",
    "APP-SELF-SERVICE-REVIEW-001",
    "APP-DELIVERY-PREPARE-001",
    "APP-DELIVERY-CONFIRM-001"
  ],
  contractNos: ["CON-DELIVERY-PREPARE-001", "CON-DELIVERY-CONFIRM-001"],
  customerNos: [
    "CUS-AUTO-REVIEW-001",
    "CUS-SELF-SERVICE-APP-001",
    "CUS-DELIVERY-PREPARE-001",
    "CUS-DELIVERY-CONFIRM-001"
  ],
  deliveryNos: ["DLV-DELIVERY-CONFIRM-001"],
  orderNos: ["ORD-AUTO-REVIEW-ET5-001", "ORD-DELIVERY-PREPARE-001", "ORD-DELIVERY-CONFIRM-001"],
  quoteNos: ["QUO-AUTO-REVIEW-ET5-001", "QUO-DELIVERY-PREPARE-001", "QUO-DELIVERY-CONFIRM-001"],
  vehicleVins: [
    "TESTAUTOORDERET5001",
    "TESTSELFAPPET5001",
    "TESTDELIVERYPREPARE001",
    "TESTDELIVERYCONFIRM001"
  ]
};

const checks = [];

try {
  await verifyBaseline();
} finally {
  await prisma.$disconnect();
}

const failedChecks = checks.filter((check) => !check.passed);

for (const check of checks) {
  const prefix = check.passed ? "PASS" : "FAIL";
  console.log(`[${prefix}] ${check.name}${check.detail ? `: ${check.detail}` : ""}`);
}

if (failedChecks.length > 0) {
  console.error(`Seed baseline verification failed: ${failedChecks.length} check(s) failed.`);
  process.exit(1);
}

console.log("Seed baseline verification passed.");

async function verifyBaseline() {
  const seedVehicles = await prisma.vehicle.findMany({
    select: {
      batteryCapacityKwh: true,
      batteryUsageType: true,
      currentSalePriceAmount: true,
      id: true,
      salePriceStatus: true,
      status: true,
      vin: true
    },
    where: {
      deletedAt: null,
      vin: { in: seedVehicleVins }
    }
  });
  const seedVehicleIds = seedVehicles.map((vehicle) => vehicle.id);
  const seedInsurancePolicies = await prisma.vehicleInsurancePolicy.findMany({
    select: {
      policyType: true,
      vehicleId: true
    },
    where: {
      deletedAt: null,
      policyStatus: "ACTIVE",
      vehicleId: { in: seedVehicleIds }
    }
  });
  const policyTypesByVehicle = new Map();
  for (const policy of seedInsurancePolicies) {
    const policyTypes = policyTypesByVehicle.get(policy.vehicleId) ?? new Set();
    policyTypes.add(policy.policyType);
    policyTypesByVehicle.set(policy.vehicleId, policyTypes);
  }
  const foundVehicleVins = new Set(seedVehicles.map((vehicle) => vehicle.vin));

  addCheck(
    "seed vehicles exist",
    seedVehicles.length === seedVehicleVins.length,
    missingDetail(seedVehicleVins, foundVehicleVins)
  );

  addCheck(
    "seed vehicles are AVAILABLE",
    seedVehicles.every((vehicle) => vehicle.status === "AVAILABLE"),
    listDetail(
      seedVehicles.filter((vehicle) => vehicle.status !== "AVAILABLE").map((vehicle) => vehicle.vin)
    )
  );

  addCheck(
    "seed vehicles have currentSalePriceAmount",
    seedVehicles.every(
      (vehicle) => vehicle.currentSalePriceAmount && vehicle.currentSalePriceAmount > 0n
    ),
    listDetail(
      seedVehicles
        .filter(
          (vehicle) => !vehicle.currentSalePriceAmount || vehicle.currentSalePriceAmount <= 0n
        )
        .map((vehicle) => vehicle.vin)
    )
  );

  addCheck(
    "seed vehicles have EFFECTIVE sale price",
    seedVehicles.every((vehicle) => vehicle.salePriceStatus === "EFFECTIVE"),
    listDetail(
      seedVehicles
        .filter((vehicle) => vehicle.salePriceStatus !== "EFFECTIVE")
        .map((vehicle) => vehicle.vin)
    )
  );

  addCheck(
    "seed vehicles have active compulsory and commercial policies",
    seedVehicles.every((vehicle) => {
      const policyTypes = policyTypesByVehicle.get(vehicle.id);
      return policyTypes?.has("COMPULSORY_TRAFFIC") && policyTypes.has("COMMERCIAL");
    }),
    listDetail(
      seedVehicles
        .filter((vehicle) => {
          const policyTypes = policyTypesByVehicle.get(vehicle.id);
          return !policyTypes?.has("COMPULSORY_TRAFFIC") || !policyTypes.has("COMMERCIAL");
        })
        .map((vehicle) => vehicle.vin)
    )
  );

  addCheck(
    "seed vehicles have battery data",
    seedVehicles.every((vehicle) => vehicle.batteryCapacityKwh && vehicle.batteryUsageType),
    listDetail(
      seedVehicles
        .filter((vehicle) => !vehicle.batteryCapacityKwh || !vehicle.batteryUsageType)
        .map((vehicle) => vehicle.vin)
    )
  );

  const salePriceHistory = await prisma.vehicleSalePriceHistory.findMany({
    distinct: ["vehicleId"],
    select: { vehicleId: true },
    where: {
      reviewType: "INITIAL_POOL",
      vehicleId: { in: seedVehicleIds }
    }
  });

  addCheck(
    "seed vehicles have INITIAL_POOL sale price history",
    salePriceHistory.length === seedVehicleIds.length,
    `${salePriceHistory.length}/${seedVehicleIds.length}`
  );

  await verifyCatalog();
  await verifyCustomerLeads();
  await verifyNoFlowSeedData(seedVehicleIds);
}

async function verifyCatalog() {
  const product = await prisma.product.findFirst({
    select: { id: true },
    where: {
      deletedAt: null,
      productNo: baselineCatalog.productNo,
      status: "ACTIVE"
    }
  });
  addCheck("baseline product is ACTIVE", Boolean(product));

  const productVersion = await prisma.productVersion.findFirst({
    select: { id: true },
    where: {
      deletedAt: null,
      status: "ACTIVE",
      versionNo: baselineCatalog.versionNo
    }
  });
  addCheck("baseline product version is ACTIVE", Boolean(productVersion));

  const [
    vehiclePackageCount,
    mileagePackageCount,
    energyPackageCount,
    benefitPackageCount,
    planCount
  ] = await Promise.all([
    prisma.vehiclePackage.count({
      where: { deletedAt: null, packageNo: baselineCatalog.vehiclePackageNo, status: "ACTIVE" }
    }),
    prisma.mileagePackage.count({
      where: { deletedAt: null, packageNo: baselineCatalog.mileagePackageNo, status: "ACTIVE" }
    }),
    prisma.energyPackage.count({
      where: { deletedAt: null, packageNo: baselineCatalog.energyPackageNo, status: "ACTIVE" }
    }),
    prisma.benefitPackage.count({
      where: { deletedAt: null, packageNo: baselineCatalog.benefitPackageNo, status: "ACTIVE" }
    }),
    prisma.subscriptionPlan.count({
      where: { deletedAt: null, planNo: baselineCatalog.planNo, status: "ACTIVE" }
    })
  ]);

  addCheck(
    "baseline vehicle package is ACTIVE",
    vehiclePackageCount === 1,
    String(vehiclePackageCount)
  );
  addCheck(
    "baseline mileage package is ACTIVE",
    mileagePackageCount === 1,
    String(mileagePackageCount)
  );
  addCheck(
    "baseline energy package is ACTIVE",
    energyPackageCount === 1,
    String(energyPackageCount)
  );
  addCheck(
    "baseline benefit package is ACTIVE",
    benefitPackageCount === 1,
    String(benefitPackageCount)
  );
  addCheck("baseline subscription plan is ACTIVE", planCount === 1, String(planCount));
}

async function verifyCustomerLeads() {
  const leads = await prisma.customer.findMany({
    select: { customerNo: true },
    where: {
      customerNo: { in: seedCustomerNos },
      deletedAt: null,
      status: "LEAD"
    }
  });
  const foundCustomerNos = new Set(leads.map((lead) => lead.customerNo));

  addCheck(
    "baseline customer leads exist",
    leads.length === seedCustomerNos.length,
    missingDetail(seedCustomerNos, foundCustomerNos)
  );
}

async function verifyNoFlowSeedData(seedVehicleIds) {
  const oldCustomers = await prisma.customer.findMany({
    select: { id: true },
    where: { customerNo: { in: oldDefaultFlowSeedData.customerNos } }
  });
  const oldCustomerIds = oldCustomers.map((customer) => customer.id);

  const oldVehicles = await prisma.vehicle.findMany({
    select: { id: true },
    where: { vin: { in: oldDefaultFlowSeedData.vehicleVins } }
  });
  const oldVehicleIds = oldVehicles.map((vehicle) => vehicle.id);
  const cleanupVehicleIds = [...oldVehicleIds, ...seedVehicleIds];

  const applications = await prisma.application.findMany({
    select: { id: true },
    where: {
      OR: [
        { applicationNo: { in: oldDefaultFlowSeedData.applicationNos } },
        ...(oldCustomerIds.length > 0 ? [{ customerId: { in: oldCustomerIds } }] : []),
        ...(cleanupVehicleIds.length > 0
          ? [
              { finalVehicleId: { in: cleanupVehicleIds } },
              { intentVehicleId: { in: cleanupVehicleIds } },
              { softReservedVehicleId: { in: cleanupVehicleIds } }
            ]
          : [])
      ]
    }
  });
  const applicationIds = applications.map((application) => application.id);

  const quotes = await prisma.subscriptionQuote.findMany({
    select: { id: true },
    where: {
      OR: [
        { quoteNo: { in: oldDefaultFlowSeedData.quoteNos } },
        ...(applicationIds.length > 0 ? [{ applicationId: { in: applicationIds } }] : []),
        ...(oldCustomerIds.length > 0 ? [{ customerId: { in: oldCustomerIds } }] : []),
        ...(cleanupVehicleIds.length > 0 ? [{ vehicleId: { in: cleanupVehicleIds } }] : [])
      ]
    }
  });
  const quoteIds = quotes.map((quote) => quote.id);

  const orders = await prisma.subscriptionOrder.findMany({
    select: { id: true },
    where: {
      OR: [
        { orderNo: { in: oldDefaultFlowSeedData.orderNos } },
        ...(applicationIds.length > 0 ? [{ applicationId: { in: applicationIds } }] : []),
        ...(quoteIds.length > 0 ? [{ quoteId: { in: quoteIds } }] : []),
        ...(oldCustomerIds.length > 0 ? [{ customerId: { in: oldCustomerIds } }] : []),
        ...(cleanupVehicleIds.length > 0 ? [{ vehicleId: { in: cleanupVehicleIds } }] : [])
      ]
    }
  });
  const orderIds = orders.map((order) => order.id);

  addCheck(
    "old default seed applications are absent",
    applications.length === 0,
    String(applications.length)
  );
  addCheck("old default seed quotes are absent", quotes.length === 0, String(quotes.length));
  addCheck("old default seed orders are absent", orders.length === 0, String(orders.length));

  const [
    contractCount,
    deliveryCount,
    returnCount,
    billCount,
    paymentCount,
    writeOffCount,
    depositLedgerCount,
    collectionCaseCount,
    entitlementAccountCount,
    entitlementGrantCount,
    entitlementUsageCount
  ] = await Promise.all([
    prisma.contract.count({
      where: whereAny([
        { contractNo: { in: oldDefaultFlowSeedData.contractNos } },
        ...(orderIds.length > 0 ? [{ orderId: { in: orderIds } }] : []),
        ...(oldCustomerIds.length > 0 ? [{ customerId: { in: oldCustomerIds } }] : [])
      ])
    }),
    prisma.vehicleDelivery.count({
      where: whereAny([
        { deliveryNo: { in: oldDefaultFlowSeedData.deliveryNos } },
        ...(orderIds.length > 0 ? [{ orderId: { in: orderIds } }] : []),
        ...(cleanupVehicleIds.length > 0 ? [{ vehicleId: { in: cleanupVehicleIds } }] : []),
        ...(oldCustomerIds.length > 0 ? [{ customerId: { in: oldCustomerIds } }] : [])
      ])
    }),
    prisma.vehicleReturn.count({
      where: whereAny([
        ...(orderIds.length > 0 ? [{ orderId: { in: orderIds } }] : []),
        ...(cleanupVehicleIds.length > 0 ? [{ vehicleId: { in: cleanupVehicleIds } }] : []),
        ...(oldCustomerIds.length > 0 ? [{ customerId: { in: oldCustomerIds } }] : [])
      ])
    }),
    prisma.receivableBill.count({
      where: whereAny([
        ...(orderIds.length > 0 ? [{ orderId: { in: orderIds } }] : []),
        ...(oldCustomerIds.length > 0 ? [{ customerId: { in: oldCustomerIds } }] : [])
      ])
    }),
    prisma.paymentRecord.count({
      where: whereAny([
        ...(orderIds.length > 0 ? [{ orderId: { in: orderIds } }] : []),
        ...(oldCustomerIds.length > 0 ? [{ customerId: { in: oldCustomerIds } }] : [])
      ])
    }),
    prisma.paymentWriteOff.count({
      where: whereAny([
        ...(orderIds.length > 0 ? [{ orderId: { in: orderIds } }] : []),
        ...(oldCustomerIds.length > 0 ? [{ customerId: { in: oldCustomerIds } }] : [])
      ])
    }),
    prisma.depositLedger.count({
      where: whereAny([
        ...(orderIds.length > 0 ? [{ orderId: { in: orderIds } }] : []),
        ...(oldCustomerIds.length > 0 ? [{ customerId: { in: oldCustomerIds } }] : [])
      ])
    }),
    prisma.collectionCase.count({
      where: whereAny([
        ...(orderIds.length > 0 ? [{ orderId: { in: orderIds } }] : []),
        ...(oldCustomerIds.length > 0 ? [{ customerId: { in: oldCustomerIds } }] : [])
      ])
    }),
    prisma.orderEntitlementAccount.count({
      where: whereAny([
        ...(orderIds.length > 0 ? [{ orderId: { in: orderIds } }] : []),
        ...(oldCustomerIds.length > 0 ? [{ customerId: { in: oldCustomerIds } }] : [])
      ])
    }),
    prisma.orderEntitlementGrant.count({
      where: whereAny([
        ...(orderIds.length > 0 ? [{ orderId: { in: orderIds } }] : []),
        ...(oldCustomerIds.length > 0 ? [{ customerId: { in: oldCustomerIds } }] : [])
      ])
    }),
    prisma.orderEntitlementUsage.count({
      where: whereAny([
        ...(orderIds.length > 0 ? [{ orderId: { in: orderIds } }] : []),
        ...(oldCustomerIds.length > 0 ? [{ customerId: { in: oldCustomerIds } }] : [])
      ])
    })
  ]);

  addCheck("old default seed contracts are absent", contractCount === 0, String(contractCount));
  addCheck(
    "old default seed delivery records are absent",
    deliveryCount === 0,
    String(deliveryCount)
  );
  addCheck("old default seed return records are absent", returnCount === 0, String(returnCount));
  addCheck("old default seed bills are absent", billCount === 0, String(billCount));
  addCheck("old default seed payments are absent", paymentCount === 0, String(paymentCount));
  addCheck("old default seed write-offs are absent", writeOffCount === 0, String(writeOffCount));
  addCheck(
    "old default seed deposit ledgers are absent",
    depositLedgerCount === 0,
    String(depositLedgerCount)
  );
  addCheck(
    "old default seed collection cases are absent",
    collectionCaseCount === 0,
    String(collectionCaseCount)
  );
  addCheck(
    "old default seed entitlement accounts are absent",
    entitlementAccountCount === 0,
    String(entitlementAccountCount)
  );
  addCheck(
    "old default seed entitlement grants are absent",
    entitlementGrantCount === 0,
    String(entitlementGrantCount)
  );
  addCheck(
    "old default seed entitlement usages are absent",
    entitlementUsageCount === 0,
    String(entitlementUsageCount)
  );
}

function addCheck(name, passed, detail = "") {
  checks.push({ detail, name, passed });
}

function listDetail(values) {
  return values.length > 0 ? values.join(", ") : "";
}

function missingDetail(expectedValues, foundValues) {
  const missing = expectedValues.filter((value) => !foundValues.has(value));
  return missing.length > 0 ? `missing ${missing.join(", ")}` : "";
}

function whereAny(clauses) {
  return clauses.length > 0 ? { OR: clauses } : { id: { in: [] } };
}

function normalizeLocalhostDatabaseUrl(value) {
  const url = new URL(value);
  if (url.hostname === "localhost") {
    url.hostname = "127.0.0.1";
  }
  return url.toString();
}
