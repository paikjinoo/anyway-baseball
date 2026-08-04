import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // three.js는 ESM 빌드를 그대로 쓰므로 트랜스파일 대상에 포함시킨다.
  transpilePackages: ['three'],
  typescript: {
    ignoreBuildErrors: false,
  },
};

export default nextConfig;
