/** October 2026 security floors: native Brotli, TLS and eMudhra CA fixes. */
export const NODE_REQUIREMENT = "^22.23.4 || ^24.22.1 || ^26.12.1";

export function isSupportedNode(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  const floor = new Map<number, [number, number]>([
    [22, [23, 4]],
    [24, [22, 1]],
    [26, [12, 1]],
  ]).get(major);
  if (!floor) return false;
  const [minMinor, minPatch] = floor;
  return minor > minMinor || (minor === minMinor && patch >= minPatch);
}
