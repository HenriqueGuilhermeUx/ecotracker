# Sourcing Klima / Carbonmark x402

## Escopo desta fase

O EcoTracker usa o endpoint público x402 da Klima/Carbonmark como uma segunda fonte de discovery de créditos retirable em Base.

Nesta fase a integração é deliberadamente **read-only**:

- `discover`: lê classes, registries, projetos, vintages, liquidez e preço spot;
- `quote`: permite preview de preço real para uma quantidade específica;
- nenhuma assinatura EIP-712 é solicitada;
- nenhum USDC/kVCM é movimentado;
- nenhuma aposentadoria é executada;
- nenhum checkout EcoTracker é liberado para ativos x402.

## Segurança comercial

Os ativos x402 entram em `monitored_assets` com:

- `pricing_mode = quote`;
- `claim_category = climate_contribution`;
- `eligibility_status = restricted`;
- flag `x402-discovery-only-not-enabled-for-ecotracker-checkout`;
- flag `x402-spot-price-requires-live-quote-before-purchase`.

Mesmo que o registry e o vintage pareçam compatíveis com a política EcoTracker, o ativo não é promovido automaticamente para compensação verificada nesta fase.

A rota `POST /api/market/quotes` intercepta ativos x402 e devolve `X402_EXECUTION_NOT_ENABLED`, impedindo que o preço spot do catálogo caia na cobrança genérica.

## Endpoints EcoTracker

- `GET /api/market/klima-x402/status`
- `GET /api/market/klima-x402/quote-preview?assetId=<id>&kg=<kg>`
- `POST /api/admin/market/klima-x402/refresh`

O catálogo x402 também é atualizado antes das leituras públicas de mercado e sourcing.

## Próxima fase

A execução futura deve ser implementada separadamente e permanecer desligada por padrão. Antes de habilitar checkout, o EcoTracker deve:

1. obter `/quote` ao vivo para a quantidade exata;
2. calcular preço final e TTL a partir desse quote;
3. preparar e validar a autorização EIP-712;
4. executar retirement com idempotência;
5. confirmar transação e certificado;
6. só então concluir fulfillment ECOT.

Aposentadoria é irreversível; discovery e execução permanecem módulos distintos.
