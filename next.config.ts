import type {NextConfig} from 'next';
const config:NextConfig={
  poweredByHeader:false,
  ...(process.env.STUDIO_BUILD_IN_PROCESS === '1' ? { experimental: { webpackBuildWorker: false, workerThreads: true, cpus: 2, useTypeScriptCli: false } } : {}),
};
export default config;
