import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: { "/api/warehouse-companion": ["./lib/warehouse/vision/runtime/package.json", "./lib/warehouse/vision/runtime/node_modules/**/*"], "/api/warehouse/scanner-download": ["./companion/**"], "/api/warehouse": ["./lib/warehouse/vision/runtime/package.json", "./lib/warehouse/vision/runtime/node_modules/**/*"] },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "tcgplayer-cdn.tcgplayer.com", pathname: "/product/**" },
      { protocol: "https", hostname: "tradingcardmarket.com", pathname: "/cdn/shop/files/**" },
      { protocol: "https", hostname: "totalcards.net", pathname: "/cdn/shop/articles/**" },
      { protocol: "https", hostname: "cardifacts.com", pathname: "/cdn/shop/files/**" },
      { protocol: "https", hostname: "target.scene7.com", pathname: "/is/image/Target/**" },
      { protocol: "https", hostname: "www.incomgaming.co.uk", pathname: "/cdn/shop/files/**" },
      { protocol: "https", hostname: "gbtoys.com.au", pathname: "/cdn/shop/files/**" },
      { protocol: "https", hostname: "tcgcollectornz.com", pathname: "/cdn/shop/files/**" },
    ],
  },
};

export default nextConfig;