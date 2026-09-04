import { vercelPreset } from "@vercel/react-router/vite";
import type { Config } from "@react-router/dev/config";

// This app's real production target is a Docker container on the
// company's own AWS server (see AWS_DEPLOY.md), served by
// `react-router-serve` via package.json's `start` script - the Vercel
// preset changes the build output into Vercel's own function format,
// which that server script can't run. Only opt into it when actually
// building on Vercel (which sets its own VERCEL=1 automatically), so a
// Vercel trial deploy doesn't silently change what the AWS build
// produces.
export default {
  ssr: true,
  presets: process.env.VERCEL ? [vercelPreset()] : [],
} satisfies Config;
