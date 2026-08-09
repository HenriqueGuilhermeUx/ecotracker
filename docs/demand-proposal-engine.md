# EcoTracker Corporate Proposal Engine

## Objetivo

Transformar uma oportunidade do Demand Radar + o plano do Matching Engine em uma proposta comercial auditável, sem confundir proposta indicativa com checkout executável.

## Fluxo

`Demand Account -> inventário GHG -> oportunidade -> matching -> proposta -> cotação/checkout -> retirement -> certificado`.

## Pricing

O motor captura source price, FX, quantidade, custo-fonte, modo de execução e evidência registral de cada ativo claim-ready. O custo agregado passa pela mesma `pricing-policy` do EcoTracker.

Se algum ativo exigir live quote e não tiver preço suficiente, a proposta pode existir, mas sem preço final travado.

## Single asset vs basket

- cobertura integral com 1 ativo -> `checkout_mode=single_asset_quote` e template para a quote existente;
- múltiplos ativos ou cobertura parcial -> `checkout_mode=basket_quote_required`.

Não existe cobrança multi-lote automática enquanto a basket rail não estiver implementada.

## Link compartilhável

`GET /api/demand/proposals/:publicCode`

Expõe apenas volume, preço comercial, projetos, registry, vintage, evidência e validade. Não expõe custo-fonte, margem nem contatos internos.

## Endpoints admin

- `POST /api/admin/demand/opportunities/:id/proposal`
- `GET /api/admin/demand/proposals`
- `GET /api/admin/demand/proposals/:id`
- `POST /api/admin/demand/proposals/:id/status`

## Regra climática

O inventário Scope 1/2/3 permanece separado da compensação. O claim só se conclui após aposentadoria exclusiva dos créditos para o beneficiário e evidência registral.
