export interface VehicleInsurancePolicyCoverageSummary {
  covered: boolean;
  effectiveFrom: string | null;
  effectiveTo: string | null;
}

export interface VehicleInsuranceCoverageSummary {
  commercial: VehicleInsurancePolicyCoverageSummary;
  compulsoryTraffic: VehicleInsurancePolicyCoverageSummary;
  covered: boolean;
  evaluatedAt: string;
}

export interface VehicleWorkspaceVehicle {
  acquisitionMode: string | null;
  assetLocation: string | null;
  batteryCapacityKwh: number | null;
  batteryUsageType: string | null;
  brand: string;
  currentMileageKm: number;
  currentSalePriceAmount: number | null;
  id: string;
  insuranceCoverage: VehicleInsuranceCoverageSummary;
  latestRegistrationDate: string | null;
  model: string | null;
  modelDisplayName: string | null;
  modelYear: number | null;
  nextSalePriceReviewAt: string | null;
  plateNo: string | null;
  purchaseDate: string | null;
  registrationDate: string | null;
  salePriceStatus: string;
  series: string | null;
  status: string;
  updatedAt: string;
  vehicleNo: string;
  vin: string | null;
}

export interface VehicleWorkspaceTabProps {
  onVehicleChanged: () => Promise<void>;
  permissions: ReadonlySet<string>;
  vehicle: VehicleWorkspaceVehicle;
}
