# EcoTracker Corporate Proposal Engine

## Objetivo

Transformar uma oportunidade do Demand Radar + o plano do Matching Engine em uma proposta comercial auditável, sem confundir proposta indicativa com checkout executável.

## Fluxo

`Demand Account -> inventário GHG -> oportunidade -> matching -> proposta -> cotação/checkout -> retirement -> certificado`.

## Pricing

Para cada ativo claim-ready usado no plano, o motor captura:

- source price em USD/t;
- FX BRL/USD monitorado;
- quantidade alocada;
- custo-fonte em BRL;
- modo de execução;
- evidência registral.

O custo-fonte agregado passa pela mesma `pricing-policy` do EcoTracker, respeitando tier de markup e fee mínimo por volume.

Se algum ativo exigir live quote e não possuir preço monitorado suficiente, a proposta continua podendo existir, mas sem `final_total_brl` travado.

## Single asset vs basket

O checkout atual do EcoTracker é orientado a um ativo por quote.

Por isso:

- cobertura integral com 1 ativo -> `checkout_mode=single_asset_quote` e o backend devolve `quoteRequestTemplate`;
- múltiplos ativos ou cobertura parcial -> `checkout_mode=basket_quote_required`.

O sistema não cria uma cobrança única multi-lote enquanto a basket rail não existir.

## Link compartilhável

`GET /api/demand/proposals/:publicCode`

Retorna apenas dados comerciais necessários ao comprador:

- empresa;
- volume alvo/coberto;
- preço final indicativo;
- projetos/registry/vintage;
- evidence URL;
- execution mode;
- validade;
- disclosure de retirement.

Não expõe custo-fonte, margem ou dados de contato internos.

## Endpoints admin

- `POST /api/admin/demand/opportunities/:id/proposal`
- `GET /api/admin/demand/proposals`
- `GET /api/admin/demand/proposals/:id`
- `POST /api/admin/demand/proposals/:id/status`

## Regra climática

A proposta não altera o inventário Scope 1/2/3 da empresa. A operação de compensação é separada e só se conclui após retirement exclusivo dos créditos para o beneficiário, com evidência registral.
