# EcoTracker Supply Eligibility Gate

## Objetivo

Fechar a ponte operacional entre um `Supply Intake` convertido e um ativo `claim-ready`, sem confundir elegibilidade climática com execução programática de provider.

## Fluxo

`seller-confirmed -> Supply Intake -> mandate/inventory -> monitored candidate restricted -> Supply Eligibility Review -> claim-ready -> Matching Engine -> RFQ`

## Aprovação claim-ready

A aprovação especializada exige:

- Supply Intake convertido e previamente aprovado;
- KYC/legal aprovado;
- evidência registral verificada;
- termos comerciais aprovados;
- registry project id e batch/reference;
- evidência pública do registry/projeto;
- validade comercial vigente;
- retirement suportado;
- retirement em nome do beneficiário;
- confirmação humana explícita de que as unidades estão `tradable`;
- fundamentação auditável de elegibilidade;
- justificativa quando houver override de vintage.

A decisão é congelada em snapshot SHA-256 e se torna imutável no PostgreSQL.

## Efeito no ativo

Uma aprovação válida muda o monitored asset para:

- `claim_category=voluntary_offset`
- `eligibility_status=eligible`
- `source_unit_status=tradable`
- `sourcing_shelf=verified_compensation`
- `eligibility_checked_at=NOW()`

O gate força:

- `sourcing_executable=false`

A existência de um claim climático válido não prova que Carbonmark, Regen ou qualquer outra rail está habilitada para execução automática.

## Matching automático

Depois do commit da decisão de eligibility, o EcoTracker executa novamente o Matching Engine da oportunidade vinculada. Se a nova oferta claim-ready cobrir integralmente a demanda, o RFQ pode ser marcado como `resolved` imediatamente.

Falha no refresh do Matching não desfaz a decisão climática já auditada; ela é registrada como evento operacional para revisão.

## Decisão restritiva

O operador também pode decidir manter o lote como contribuição climática/restrita. Essa decisão também recebe snapshot SHA-256 e é final/imutável para aquele intake, evitando promoção silenciosa posterior.

## Carbon Desk

A Carbon Desk mostra três grupos:

- aguardando revisão;
- claim-ready;
- restritos.

A fila exibe volume, fornecedor, registry/projeto, buyer/RFQ, gap, evidências, estado do claim e estado independente de execução.

## Endpoints

- `GET /api/admin/supply/eligibility-queue`
- `POST /api/admin/supply/intakes/:id/eligibility/approve`
- `POST /api/admin/supply/intakes/:id/eligibility/restrict`

## Gate de CI

`EcoTracker Supply Eligibility Smoke` prova em PostgreSQL 16 + HTTP runtime:

1. intake convertido aparece na fila;
2. aprovação sem tradability explícita é bloqueada;
3. aprovação gera SHA-256;
4. ativo vira voluntary offset + eligible + tradable;
5. shelf vira verified compensation;
6. execução programática continua falsa;
7. Matching Engine roda automaticamente;
8. RFQ fecha somente com cobertura claim-ready integral;
9. aprovação repetida é idempotente;
10. decisão final é imutável no PostgreSQL.
