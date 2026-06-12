// Euclidean rhythm is the rhythmic vocabulary: E(k, n) spreads k onsets as
// evenly as possible across n slots (Bjorklund). Rotation phases patterns
// against each other, Reich-fashion, while staying locked to one clock.

/** E(k, n) as a boolean array of length n; index 0 is the cycle start. */
export function euclid(k: number, n: number): boolean[] {
  if (n <= 0) return [];
  const hits = Math.max(0, Math.min(k, n));
  const pattern: boolean[] = [];
  let bucket = 0;
  for (let i = 0; i < n; i++) {
    bucket += hits;
    if (bucket >= n) {
      bucket -= n;
      pattern.push(true);
    } else {
      pattern.push(false);
    }
  }
  return pattern;
}

/** Rotate a pattern so it starts at the given offset. */
export function rotate<T>(pattern: readonly T[], offset: number): T[] {
  const n = pattern.length;
  if (n === 0) return [];
  const shift = ((offset % n) + n) % n;
  return pattern.map((_, i) => pattern[(i + shift) % n] as T);
}
