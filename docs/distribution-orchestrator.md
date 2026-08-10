# EcoTracker Distribution Orchestrator v1

## Objetivo

Transformar inventário claim-ready do EcoTracker em exposição comercial multicanal sem multiplicar o estoque econômico nem fingir integrações automáticas que ainda não existem.

## Fluxo

`claim-ready inventory -> mandato/canais autorizados -> plano multicanal -> exposição confirmada -> reserva global -> venda/settlement`

## Invariante econômica

Um lote de 30.000 t pode ser anunciado como 30.000 t em Carbonmark, 30.000 t em Regen e 30.000 t em OTC.

Isso representa 90.000 t de **exposição comercial**, mas continua representando somente 30.000 t de **estoque econômico**.

A capacidade é sempre:

`authorized_tonnes - sold_tonnes - active_reserved_tonnes`

Todas as reservas, independentemente do canal, usam `supply_reservations` e o trigger PostgreSQL do Supply Desk. Portanto, uma reserva em Carbonmark reduz imediatamente o saldo disponível para Regen, OTC e qualquer outro canal.

## Autorização do fornecedor

Supply Intake cria mandato inicial restrito a `direct` + `otc`.

Para adicionar Carbonmark, Regen, Toucan ou outro canal, o operador precisa registrar um amendment do mandato contendo:

- canais autorizados;
- evidência contratual/pública;
- nota comercial;
- operador;
- snapshot SHA-256.

O amendment é imutável no PostgreSQL.

## Claim-ready obrigatório

O Distribution Orchestrator só cria planos para inventário que:

- esteja ligado a um `Supply Intake` convertido;
- possua `Supply Eligibility Review` aprovada;
- continue passando `evaluateAssetEligibility(..., voluntary_offset)` no momento do planejamento.

## Claim-ready não significa execução automática

O Orchestrator nunca altera `sourcing_executable`.

No v1:

- `direct`: operação interna/manual;
- `otc`: operação manual OTC;
- `carbonmark`: marketplace externo, confirmação externa obrigatória;
- `regen`: onboarding/listagem externa, confirmação obrigatória;
- `toucan`: onboarding externo;
- `other`: integração manual.

`automaticPublish=false` para todos os canais nesta versão.

Carbonmark também expõe o estado de `CARBONMARK_ORDER_EXECUTION_ENABLED`, mas o Distribution Orchestrator não habilita essa flag.

## Plano de distribuição

O plano:

- valida claim-ready;
- valida mandato ativo e vigente;
- valida canais autorizados;
- congela saldo global disponível;
- aplica floor price do fornecedor;
- calcula ask price por markup de distribuição (default 15% via `ECOT_DISTRIBUTION_MARKUP_PCT`) ou ask explícito;
- cria uma revisão imutável com SHA-256;
- cria/atualiza listings `planned` por canal.

Cada listing anuncia o mesmo saldo global disponível no instante do plano. Os volumes anunciados não são somados como capacidade econômica.

## Ativação de canal

Canais externos só podem virar `active` após informar `externalListingId` ou `externalUrl`.

Isso significa apenas que a exposição comercial foi confirmada externamente. Não significa que compra/retirement estejam automatizados.

## Reservas

Reserva exige:

- inventário ainda claim-ready;
- canal ativo;
- `externalOrderId` obrigatório;
- volume menor ou igual ao saldo global disponível.

`externalOrderId` é idempotente por `inventory + channel + order`.

Reservas com `reserved_until` vencido são marcadas como `expired` antes de novas operações do Orchestrator.

## Rotas

- `GET /api/admin/distribution/desk`
- `POST /api/admin/distribution/mandates/:id/channels`
- `POST /api/admin/distribution/inventory/:id/plan`
- `POST /api/admin/distribution/inventory/:id/channels/:channel/activate`
- `POST /api/admin/distribution/inventory/:id/channels/:channel/reserve`

## Carbon Desk

O Distribution Board mostra:

- lotes claim-ready;
- autorizado / vendido / reservado / disponível global;
- floor price;
- canais permitidos pelo mandato;
- amendment auditável;
- planejamento multicanal;
- status de listings;
- confirmação externa;
- reservas globais ativas;
- estado separado de execução programática.

## Smoke PostgreSQL

O smoke dedicado prova com um lote de 10.000 t:

1. Carbonmark/Regen são bloqueados antes do amendment;
2. amendment gera SHA-256;
3. plano anuncia 10.000 t em Carbonmark, Regen e OTC;
4. estoque econômico continua 10.000 t;
5. Carbonmark não ativa sem referência externa;
6. reserva Carbonmark de 6.000 t é criada;
7. replay do mesmo order ID é idempotente;
8. tentativa OTC de 5.000 t é bloqueada;
9. reserva OTC de 4.000 t completa 10.000 t;
10. saldo global final é zero;
11. deployment/amendment são imutáveis;
12. `sourcing_executable` continua FALSE.
