/** @type {import('next').NextConfig} */
export default {
  transpilePackages: ["@gym/core"],
  serverExternalPackages: ["@electric-sql/pglite", "exceljs"],
};
