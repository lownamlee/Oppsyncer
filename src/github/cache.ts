export function addNoCacheQuery(
  path: string,
  timestamp: number,
  sequence: number,
): string {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}obsyncer_no_cache=${timestamp}-${sequence}`;
}
