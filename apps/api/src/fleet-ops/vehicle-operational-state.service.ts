import { Injectable } from "@nestjs/common";

import { VehicleOperationalStateRepository } from "./vehicle-operational-state.repository";
import { VehicleOperationalStateResolver } from "./vehicle-operational-state.resolver";

@Injectable()
export class VehicleOperationalStateService {
  private readonly resolver = new VehicleOperationalStateResolver();

  constructor(private readonly repository: VehicleOperationalStateRepository) {}

  async resolveVehicleOperationalState(vehicleId: string, asOf: Date = new Date()) {
    const snapshot = await this.repository.loadVehicleOperationalStateSnapshot(vehicleId, asOf);

    return this.resolver.resolve(snapshot);
  }
}
