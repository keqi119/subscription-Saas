export const TEST_MODEL_CODES = {
  EC6: "NIO_EC6",
  ES6: "NIO_ES6",
  ES8: "NIO_ES8",
  ES9: "NIO_ES9",
  ET5: "NIO_ET5",
  ET5T: "NIO_ET5T",
  ET7: "NIO_ET7",
  ET9: "NIO_ET9"
} as const;

export type TestModelCode = (typeof TEST_MODEL_CODES)[keyof typeof TEST_MODEL_CODES];
