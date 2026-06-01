export interface HealthResponse {
  service: string;
  status: "ok";
  storage: "local";
  timestamp: string;
}

export class AppService {
  getHealth(): HealthResponse {
    return {
      service: "subscription-saas-api",
      status: "ok",
      storage: "local",
      timestamp: new Date().toISOString()
    };
  }
}
