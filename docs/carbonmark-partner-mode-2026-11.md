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

Public Carbonmark material published in 2026 identifies **v20** as the current stable API release. EcoTracker therefore treats:

- target stable version: **v20**;
- currently configured version: derived from `CARBONMARK_API_BASE`;
- migration required: true whenever the configured version is older than the target.

The code must never infer the persisted API version from a hardcoded string. Shadow quotes persist the **active** API version used for that observation.

The retirement flow remains:

`carbonProjects / prices -> POST /quotes -> POST /orders -> poll order -> retirement/certificate/provenance`

## Production execution gates

No production retirement is enabled by this change.

Production order execution remains allowed only when both controls are explicitly armed:

- `CARBONMARK_ORDER_EXECUTION_ENABLED=true`
- `CARBONMARK_ORDER_EXECUTION_ACK=ENABLE_LIVE_CARBONMARK_RETIREMENTS`

A configured API key or funded API Credits balance is not enough to enable execution.

## API Credits commercial model

Partner correspondence and Carbonmark's published terms indicate the current commercial direction:

- prepaid API Credits;
- reference starter funding discussed: **US$50**;
- credits do not expire;
- Settlement & Processing Fee: **3%** on top-ups;
- production access remains subject to onboarding / whitelist.

These values are displayed as readiness information only. They do not authorize automatic charging, top-up, order creation or retirement.

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
- seller/distribution: AWAITING CARBONMARK RESPONSE;
- automatic seller listing: OFF;
- API Credits reference: US$50;
- top-up fee reference: 3%;
- credits: NON-EXPIRING;
- production: ONBOARDING.

This information is operational context, not a promise to clients.

## What happens when Carbonmark replies

The response should be classified into one of these tracks:

### A. Production API approved

Validate v20 in sandbox/production credentials, then change `CARBONMARK_API_BASE` only after smoke tests. Keep order execution OFF until a separate explicit live-execution decision.

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
