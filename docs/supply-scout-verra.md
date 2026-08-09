# Verra Brazil Supply Scout

## Objetivo

Transformar o Public Report do VCS em leads comerciais de projetos brasileiros com créditos já emitidos.

O scanner não origina projeto, não revalida metodologia e não presume que saldo registral esteja livre para venda.

## Dados utilizados

O Public Report da Verra expõe dados úteis para prospecção, incluindo:

- projeto e ID;
- país/região;
- proponente;
- metodologia e tipo do projeto;
- quantidade emitida;
- vintage;
- serial numbers;
- retirement/cancellation;
- beneficiário e motivo de retirement quando publicados.

## Saldo potencial

Para cada projeto:

`estimated_unretired_tonnes = issued - retired - cancelled`

Esse número é salvo em `supply_leads` como `availability_confidence=registry_estimate`.

Ele **não é estoque vendável**.

Contratos OTC, exclusividades, reservas bilaterais e compromissos comerciais podem não aparecer no registry. Só depois de contato com o proponente/detentor o EcoTracker grava `confirmed_free_tonnes` e, posteriormente, um mandato de distribuição.

## Transição do registry em 2026

A Verra lançou em julho de 2026 o novo registry baseado em S&P Global Energy. A Verra anunciou APIs de dados e conectividade transacional para fases futuras.

Por isso o EcoTracker não hard-coda endpoints privados/legados do registry antigo. Nesta fase usamos importação estruturada do Public Report e mantemos o adapter pronto para receber a API oficial quando disponibilizada.

## Endpoints

- `GET /api/admin/supply/scout/verra/status`
- `POST /api/admin/supply/scout/verra/import`
- `GET /api/admin/supply/scout/verra/candidates?minTonnes=1000`

## Pipeline

`Verra Public Report -> projeto brasileiro -> emissões/retirements -> saldo potencial -> contato -> saldo livre confirmado -> mandato -> Supply Inventory -> Carbonmark/Regen/OTC -> venda/reserva global`.

A listagem em múltiplos canais não cria estoque adicional. O Supply Desk mantém um único saldo econômico e impede over-allocation.
