/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  trailingSlash: true,
  basePath: process.env.NODE_ENV === "production" ? "/zaikokingaku-keisan-kun" : "",
  assetPrefix: process.env.NODE_ENV === "production" ? "/zaikokingaku-keisan-kun/" : "",
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
