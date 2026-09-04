/*
 * Resolves the app's own public URL across every environment this app
 * runs in: an explicit SHOPIFY_APP_URL (local dev, AWS/Docker
 * deployment - see AWS_DEPLOY.md) always wins; on Vercel specifically,
 * falls back to the platform's own VERCEL_PROJECT_PRODUCTION_URL system
 * env var so the same code works there without a manually-set URL that
 * would otherwise need updating on every custom-domain change.
 */
export function getAppUrl(): string {
  const explicit = process.env.SHOPIFY_APP_URL;
  if (explicit) return explicit.replace(/\/$/, "");

  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (vercel) return `https://${vercel}`;

  return "http://localhost:3000";
}
