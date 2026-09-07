import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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