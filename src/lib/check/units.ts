import type { LengthUnit } from "./types";

export const MM_PER_UNIT: Record<LengthUnit, number> = {
  mm: 1,
  cm: 10,
  in: 25.4,
};

/** PDF user space unit: 1/72 inch. */
export const MM_PER_POINT = 25.4 / 72;

export function toMm(value: number, unit: LengthUnit): number {
  return value * MM_PER_UNIT[unit];
}

export function fromMm(mm: number, unit: LengthUnit): number {
  return mm / MM_PER_UNIT[unit];
}

/** Round for display: inches to 3 dp, cm to 2 dp, mm to 1 dp; trims zeros. */
export function formatLength(value: number, unit: LengthUnit): string {
  const decimals = unit === "in" ? 3 : unit === "cm" ? 2 : 1;
  const rounded = Number(value.toFixed(decimals));
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

/** "24 × 36 in" */
export function formatSize(width: number, height: number, unit: LengthUnit): string {
  return `${formatLength(width, unit)} × ${formatLength(height, unit)} ${unit}`;
}

/** "24 × 36 in (609.6 × 914.4 mm)", omitting the mm part for mm orders. */
export function formatSizeWithMm(widthMm: number, heightMm: number, unit: LengthUnit): string {
  const primary = formatSize(fromMm(widthMm, unit), fromMm(heightMm, unit), unit);
  return unit === "mm" ? primary : `${primary} (${formatSize(widthMm, heightMm, "mm")})`;
}

export function formatSignedMm(deltaMm: number): string {
  const rounded = Number(deltaMm.toFixed(1));
  if (rounded === 0) return "±0 mm";
  return `${rounded > 0 ? "+" : "−"}${Math.abs(rounded)} mm`;
}
