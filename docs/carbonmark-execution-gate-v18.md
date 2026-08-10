# Carbonmark Execution Gate — v18

## Contrato adotado

EcoTracker fixa a integração Carbonmark na API estável `v18`.

A API documentada é usada para:

- descobrir projetos/listings;
- obter preços;
- criar `POST /quotes` com `asset_price_source_id` + `quantity_tonnes`;
- criar `POST /orders` para seller listings;
- consultar retirement/certificado/proveniência.

O EcoTracker não assume um endpoint REST público de criação de seller listing. Inventário próprio segue pelo Distribution Orchestrator com onboarding/listagem externa confirmada até existir contrato oficial para automação de publicação.

## Shadow quote

Criar uma quote Carbonmark trava preço/custo da fonte, mas não cria order e não aposenta crédito.

O endpoint de status expõe:

- API configurada;
- ambiente;
- stable API `v18`;
- shadow quote disponível;
- order execution bloqueada/live.

## Dupla trava de order

`POST /orders` só pode ser alcançado se simultaneamente:

- `CARBONMARK_API_KEY` estiver configurada;
- `CARBONMARK_ORDER_EXECUTION_ENABLED=true`;
- `CARBONMARK_ORDER_EXECUTION_ACK=ENABLE_LIVE_CARBONMARK_RETIREMENTS`.

Render permanece:

- `CARBONMARK_ENVIRONMENT=sandbox`;
- `CARBONMARK_API_BASE=https://v18.api.carbonmark.com`;
- `CARBONMARK_ORDER_EXECUTION_ENABLED=false`;
- `CARBONMARK_ORDER_EXECUTION_ACK=DISABLED`.

O executor verifica o gate antes de chamar qualquer endpoint de order.

## Segurança operacional

Pagamento aprovado não é autorização suficiente para aposentadoria Carbonmark.

Enquanto o gate estiver bloqueado, o commerce worker registra a execução como `blocked` e não chama `executeCarbonmarkRetirement`.

Ativar a rail ao vivo será uma mudança explícita posterior, depois de sandbox E2E e validação comercial/financeira.
