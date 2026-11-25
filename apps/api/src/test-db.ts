import { prisma } from "./lib/prisma.js";

async function main() {
  const repositories = await prisma.repository.findMany();

  console.log("Repositories saved in CODEMIND:");
  console.log(repositories);
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
  });