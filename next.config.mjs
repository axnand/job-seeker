/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ["@prisma/client", "nodemailer"],
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
