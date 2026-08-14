# Commercial Availability Matching

Demand coverage may only use assets that are both claim-ready and commercially available.

For monitored marketplace assets, a positive inventory number alone is not sufficient. Assets marked unavailable/backordered remain monitoring-only and must not contribute to `coveredTonnes`, even when catalog metadata exposes inventory.

Gold Standard storefront availability (`variant.available`) is treated as the commercial truth. Raw catalog inventory remains monitoring evidence, but sellable capacity is zero while the storefront is unavailable.
