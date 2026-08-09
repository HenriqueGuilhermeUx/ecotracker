# Sourcing Autopilot

## Missão

Manter o motor de sourcing observável e continuamente atualizado sem permitir aquisição, pagamento, promoção de elegibilidade ou aposentadoria automáticos.

## Ciclo

O Autopilot roda no boot e depois em intervalo configurável.

1. atualiza Carbonmark clássico e Klima/Carbonmark x402 usando cache dos providers;
2. reranqueia o inventário;
3. mede ativos verificados, executáveis e fracionários;
4. se o inventário verificado estiver abaixo da meta e o cooldown permitir, força uma nova varredura dos providers;
5. gera o Opportunity Report;
6. persiste um snapshot da rodada;
7. abre ou resolve alertas operacionais.

## Alertas

- `verified_inventory_below_target`
- `fractional_source_missing`
- `all_sourcing_providers_degraded`

Alertas têm estado `open`/`resolved` e histórico temporal.

## Endpoints

Público:

- `GET /api/market/sourcing/health` — saúde resumida do inventário.

Admin:

- `GET /api/admin/market/sourcing/autopilot`
- `POST /api/admin/market/sourcing/autopilot/run`
- `GET /api/admin/market/sourcing/autopilot/runs`

## Configuração padrão no Render

- `ECOT_SOURCING_AUTOPILOT_DISABLED=false`
- `ECOT_SOURCING_AUTOPILOT_INTERVAL_MS=600000` (10 min)
- `ECOT_SOURCING_REPLENISH_MIN_INTERVAL_MS=900000` (15 min)
- `ECOT_MIN_VERIFIED_OFFSET_ASSETS=5`

A execução financeira x402 permanece explicitamente desligada com `KLIMA_X402_EXECUTION_ENABLED=false`.

## Limite de autonomia

O Autopilot pode descobrir, atualizar, ranquear, diagnosticar e alertar. Ele não pode:

- comprar créditos;
- cobrar cliente;
- assinar autorização blockchain;
- executar retirement;
- mudar `eligibility_status` para `eligible`;
- mudar um ativo para claim de compensação.

Essas fronteiras mantêm sourcing autônomo separado de decisões financeiras e de integridade.
