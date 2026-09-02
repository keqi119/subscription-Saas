export function runnerError(code, details) {
  return Object.assign(new Error(code), { code, details });
}
