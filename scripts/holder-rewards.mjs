import { runHolderRewardsOperator } from "../src/holder-rewards/operator.ts";

runHolderRewardsOperator(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
