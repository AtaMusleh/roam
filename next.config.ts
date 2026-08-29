import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  images: {
    remotePatterns: [
      // Cloudinary, once real uploads exist.
      { protocol: "https", hostname: "res.cloudinary.com" },
      // picsum.photos backs the --placeholder seed, and redirects to its CDN.
      { protocol: "https", hostname: "picsum.photos" },
      { protocol: "https", hostname: "fastly.picsum.photos" },
      // Unsplash requires its images to be hotlinked rather than copied.
      { protocol: "https", hostname: "images.unsplash.com" },
    ],
  },
};

export default nextConfig;
