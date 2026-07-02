/**
 * Default long-Cooldown fallback for quota errors that carry no provider
 * retry hint: most free tiers (notably Gemini's) reset on a daily boundary.
 */
export function nextUtcMidnight(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );
}
