const VEHICLE_AVAILABILITY_DATABASES = new Set([
  "subscription_saas_codex",
  "subscription_saas_test"
]);

export function requiredVehicleAvailabilityTestDatabaseUrl(value: string | undefined) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("DATABASE_URL is required for vehicle availability integration tests");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Vehicle availability integration tests require a valid PostgreSQL URL");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("Vehicle availability integration tests require a PostgreSQL URL");
  }
  if (url.search !== "" && url.search !== "?schema=public") {
    throw new Error(
      "Vehicle availability integration tests require no query parameters except schema=public"
    );
  }
  if (!url.username) {
    throw new Error("Vehicle availability integration tests require a database user");
  }
  if (!isLoopbackHostname(url.hostname)) {
    throw new Error("Vehicle availability integration tests require a loopback PostgreSQL host");
  }

  let databaseName: string;
  try {
    databaseName = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new Error("Vehicle availability integration tests require a valid database name");
  }
  if (!VEHICLE_AVAILABILITY_DATABASES.has(databaseName)) {
    throw new Error(
      "Vehicle availability integration tests require the dedicated local or canonical CI database"
    );
  }
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url.toString();
}

function isLoopbackHostname(hostname: string) {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const octets = hostname.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
}
