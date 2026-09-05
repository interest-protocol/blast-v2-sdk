import { runDistributorOperator } from "../src/distributor/operator.ts";

runDistributorOperator(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
