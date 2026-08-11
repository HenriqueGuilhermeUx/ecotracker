import { pool } from "./db.js";
import {
  approveSupplyEligibility as approveSupplyEligibilityCore,
  listSupplyEligibilityQueue,
  restrictSupplyEligibility,
} from "./supply-eligibility-core.js";

export { listSupplyEligibilityQueue, restrictSupplyEligibility };

export async function approveSupplyEligibility(
  input: Parameters<typeof approveSupplyEligibilityCore>[0],
) {
  const result = await approveSupplyEligibilityCore(input);
  const asset = result.asset;
  const offsetDecision = result.offsetDecision;
  const assetEligibilityReviewId = Number(result.review?.asset_eligibility_review_id || 0);
  const assetEligibilityReview = assetEligibilityReviewId > 0
    ? (await pool.query(
        "SELECT * FROM asset_eligibility_reviews WHERE id=$1",
        [assetEligibilityReviewId],
      )).rows[0] || null
    : null;
  const claimReady = Boolean(
    offsetDecision?.allowed
      && asset?.claim_category === "voluntary_offset"
      && asset?.eligibility_status === "eligible"
      && asset?.source_unit_status === "tradable",
  );
  const executionAuthorization = Boolean(asset?.sourcing_executable);

  return {
    ...result,
    assetEligibilityReview,
    claimReady,
    executionAuthorization,
    executionState: executionAuthorization ? "programmatic" : "assisted_or_manual",
    integrityNote: "Claim-ready e execução programática são gates independentes.",
  };
}
