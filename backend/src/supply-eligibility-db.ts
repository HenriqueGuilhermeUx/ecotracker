import { initEligibilityReviewDb } from "./eligibility-review-db.js";
import { initSupplyEligibilityDb as initSupplyEligibilityDbCore } from "./supply-eligibility-db-core.js";

export async function initSupplyEligibilityDb(): Promise<void> {
  await initEligibilityReviewDb();
  await initSupplyEligibilityDbCore();
}
