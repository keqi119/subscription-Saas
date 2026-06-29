export function maskEnterpriseSealId(value?: string | null) {
  return maskIdentifier(value);
}

export function maskEnterpriseCustomerId(value?: string | null) {
  return maskIdentifier(value);
}

export function maskIdentifier(value?: string | null) {
  if (!value) {
    return null;
  }
  if (value.length <= 8) {
    return `${value.slice(0, 2)}...${value.slice(-2)}`;
  }
  return `${value.slice(0, 5)}...${value.slice(-4)}`;
}
