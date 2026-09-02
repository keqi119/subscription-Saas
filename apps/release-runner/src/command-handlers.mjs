export const commandHandlers = new Map([
  ["release.verify@1", async ({ baseline }) => ({ baseline, terminalStatus: "PASSED" })],
  ["schema.migrate@1", async ({ baseline }) => ({ baseline, terminalStatus: "PASSED" })],
  ["repair.execute@1", async ({ baseline }) => ({ baseline, terminalStatus: "PASSED" })],
  ["evidence.export@1", async ({ baseline }) => ({ baseline, terminalStatus: "PASSED" })]
]);
