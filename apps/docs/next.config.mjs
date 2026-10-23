import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

export default withMDX({
  output: 'export',
  transpilePackages: ['@scope/example-recipes'],
  basePath: process.env.NEXT_PUBLIC_BASE_PATH ?? '',
  reactStrictMode: true,
  images: { unoptimized: true },
  trailingSlash: true,
});
