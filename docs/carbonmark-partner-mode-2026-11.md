# Carbonmark Partner Mode — Market Maker / Origination / Distribution

Status date: 2026-11-05

## Objective

Prepare EcoTracker to operate as a carbon-market infrastructure layer connecting corporate demand to verified Brazilian and international supply, while using Carbonmark as an execution/distribution rail where commercially and technically appropriate.

This is intentionally broader than "buy credits from Carbonmark":

1. **Buy-side rail** — discover, quote, purchase/retire and return verifiable proof.
2. **EcoTracker market maker** — aggregate demand, compose baskets, price, qualify supply and keep the commercial relationship with the client.
3. **Sell-side / origination** — source verified credits from project developers and holders and prepare eligible inventory for distribution.
4. **Carbonmark distribution** — discuss seller/origination/partner listing with Carbonmark so qualified supply can reach its marketplace, API, checkout and agent channels.

## Current operating principle

Default commercial execution remains **back-to-back / on demand**. EcoTracker does not need to pre-purchase inventory to serve demand.

The system must keep these concepts separate:

- provider-quotable;
- seller-confirmed;
- claim-ready;
- commercially approved;
- executable;
- retired.

A Carbonmark quote alone is never proof of seller confirmation or climate-claim eligibility.

## Carbonmark API state

On 2026-11-05, Carbonmark confirmed the new production-access model directly to EcoTracker, but did **not** specify a new API version in that correspondence. Public documentation remains inconsistent across older versioned pages while the new self-serve dashboard is still pending release.

EcoTracker therefore follows a fail-closed version policy:

- use only the version explicitly configured in `CARBONMARK_API_BASE`;
- do not auto-upgrade based on an inferred "latest" version;
- keep the configured rail stable until the self-serve Developer dashboard confirms the production endpoint/version;
- persist the **active configured API version** with every shadow quote and execution artifact.

This avoids breaking a working integration during the Carbonmark self-serve transition.

The retirement flow remains:

`carbonProjects / prices -> POST /quotes -> POST /orders -> poll order -> retirement/certificate/provenance`

## Production execution gates

No production retirement is enabled by this change.

Production order execution remains allowed only when both controls are explicitly armed:

- `CARBONMARK_ORDER_EXECUTION_ENABLED=true`
- `CARBONMARK_ORDER_EXECUTION_ACK=ENABLE_LIVE_CARBONMARK_RETIREMENTS`

A configured API key or funded API Credits balance is not enough to enable execution.

## Production self-serve model — confirmed 2026-11-05

Carbonmark confirmed directly to EcoTracker:

- the prepaid API Credits model **replaces the previous monthly API subscription** for EcoTracker;
- EcoTracker's existing **KYB carries over**;
- when the new self-serve model is released, a **Production API key can be created after funding the account with credits**;
- minimum top-up: **US$50**;
- maximum top-up transaction: **US$500**;
- maximum account balance: **US$5,000**;
- initial weekly spend limit: **US$500**;
- API Credits **do not expire**;
- Settlement & Processing Fee: **3%** on top-ups;
- production retirements may set the **final corporate beneficiary name** and **retirement reason/message** through the API.

Carbonmark's published Terms also state that API Credits are prepaid contractual credits rather than cash/stored value, are non-transferable, do not expire, and may be subject to per-key/account spending limits.

EcoTracker policy remains stricter than the provider defaults:

- automatic top-up: **OFF**;
- live orders: **OFF** until the existing production execution gate is explicitly armed;
- automatic retirements: **OFF**;
- seller-listing automation: **OFF**.

A funded balance or Production API key alone never authorizes live execution in EcoTracker.

## Seller / origination / distribution rail

EcoTracker is preparing to act as a source-origination and market-making layer for:

- verified Brazilian credits with available unretired balances;
- international verified supply;
- corporate demand that can be matched to one or multiple projects;
- distribution through Carbonmark where the partner workflow permits it.

### Hard invariant

**Do not invent a seller-listing write API.**

Until Carbonmark confirms the seller/origination workflow and any authenticated endpoint or operational process:

- `sellerListingCreationAutomated=false`;
- no code may create or publish a Carbonmark seller listing;
- supply candidates remain internal EcoTracker opportunities;
- listing/distribution is a partner-approved step.

## Carbonmark Partner Mode status in the admin UI

The Carbonmark Rail panel exposes, separately from execution controls:

- EcoTracker role: MARKET MAKER;
- buy-side: BACK-TO-BACK;
- buy-side production model: CONFIRMED;
- KYB: CARRIED OVER;
- monthly API subscription: NOT REQUIRED;
- self-serve Production API: WAITING RELEASE;
- minimum top-up: US$50;
- maximum top-up: US$500;
- maximum balance: US$5,000;
- initial weekly spend: US$500;
- top-up fee: 3%;
- credits: NON-EXPIRING;
- beneficiary retirement: SUPPORTED;
- seller/distribution: AWAITING WORKFLOW CONFIRMATION;
- automatic seller listing: OFF.

This information is operational context, not a promise to clients.

## What happens next

The response should be classified into one of these tracks:

### A. Self-serve Production API released

Use the existing KYB account, fund with the minimum required API Credits, create a Production API key in the Developer dashboard, record the exact production base URL/version, and validate it through smoke tests. Keep order execution OFF until a separate explicit live-execution decision.

### B. Seller / origination partnership approved

Document the official supply onboarding/listing workflow. Only then implement the write path, with:

- supplier identity;
- registry/project/batch identifiers;
- available balance;
- vintage;
- price floor / ask;
- settlement preference;
- evidence;
- listing status;
- reconciliation;
- audit trail.

### C. Manual/managed seller workflow

Keep EcoTracker's origination pipeline automated internally, but hand off approved supply to Carbonmark through the agreed operational channel. Do not fake API automation.

### D. No seller pathway

Continue using Carbonmark as buy-side execution/retirement rail and distribute EcoTracker-originated supply through other approved venues.

## Client-facing separation

The **Vender** screen remains commercial and simple.

Provider names, API versions, API Credits, settlement fees, source costs, RFQ legs and seller onboarding details remain internal/ADM information and must not leak into the client-facing offer.
