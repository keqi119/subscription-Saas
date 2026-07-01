export class FleetOpsError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message);
    this.name = "FleetOpsError";
  }
}

export class FleetOpsInvalidRangeError extends FleetOpsError {
  constructor() {
    super("Fleet Ops date range is invalid: from must be less than or equal to to.", "FLEET_OPS_INVALID_RANGE");
    this.name = "FleetOpsInvalidRangeError";
  }
}
