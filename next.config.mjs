/** @type {import('next').NextConfig} */
const nextConfig = {
  devIndicators: false,
  // Pin the file-tracing root to this project. A stray lockfile in a parent dir
  // otherwise makes Next infer the wrong workspace root and trace files outside
  // the repo (slow/incorrect builds in later steps). import.meta.dirname is the
  // directory of this config file.
  outputFileTracingRoot: import.meta.dirname,
  // We run ESLint separately via `npm run lint` (eslint .), not `next lint`.
  // Disabling build-time lint keeps `next build` deterministic and non-interactive
  // (no plugin-setup prompt). Type errors still fail the build.
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
