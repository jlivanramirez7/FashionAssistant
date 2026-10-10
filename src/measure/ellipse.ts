// Ellipse circumference (design doc section 7, "Circumference method").

/**
 * Ramanujan's first approximation for an ellipse with full axes widthCm and depthCm
 * (a = w/2, b = d/2): C ~= pi * [3(a + b) - sqrt((3a + b)(a + 3b))].
 * The correction factor k is applied by the caller. Invalid input -> 0.
 */
export function ellipseCircumference(widthCm: number, depthCm: number): number {
  if (!Number.isFinite(widthCm) || !Number.isFinite(depthCm) || widthCm < 0 || depthCm < 0) return 0;
  const a = widthCm / 2;
  const b = depthCm / 2;
  return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
}
