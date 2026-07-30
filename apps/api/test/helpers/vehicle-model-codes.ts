export const VehicleModel = {
  EC6: "EC6",
  ES6: "ES6",
  ES8: "ES8",
  ES9: "ES9",
  ET5: "ET5",
  ET5T: "ET5T",
  ET7: "ET7",
  ET9: "ET9"
} as const;

export type VehicleModel = (typeof VehicleModel)[keyof typeof VehicleModel];
