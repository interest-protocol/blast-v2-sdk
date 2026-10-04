import { runPresaleVectors } from "../src/presale/vectors.ts";

runPresaleVectors(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
