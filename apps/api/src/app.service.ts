export interface HealthResponse {
  service: string;
  status: "ok";
  storage: "local" | "oss";
  timestamp: string;
}

export class AppService {
  getHealth(): HealthResponse {
    const storage = process.env.UPLOAD_STORAGE_DRIVER === "oss" ? "oss" : "local";

    return {
      service: "subscription-saas-api",
      status: "ok",
      storage,
      timestamp: new Date().toISOString()
    };
  }
}
