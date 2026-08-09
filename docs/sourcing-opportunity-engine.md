# Sourcing Opportunity Engine

## Objetivo

O Opportunity Engine transforma ativos bloqueados em uma fila operacional priorizada. Ele não muda elegibilidade e não promove ativos automaticamente.

## O que diagnostica

Para cada ativo que ainda não passa como `voluntary_offset`, o motor considera:

- provider/fonte;
- registry e vintage;
- preço e liquidez;
- status registral `tradable`;
- suporte a retirement e beneficiário;
- granularidade/fracionamento;
- evidência pública;
- idade da revisão de elegibilidade;
- `eligibility_risk_flags`;
- score/tier/rank do Sourcing Engine.

## Ações priorizadas

A fila pode recomendar, entre outras:

- concluir a rail de execução x402;
- buscar vintage mais recente;
- revisar registry/vintage;
- configurar metadata Puro;
- confirmar unidade registral;
- configurar executor de retirement;
- anexar evidência do registry;
- atualizar revisão de elegibilidade;
- confirmar preço/inventário;
- buscar fonte com menor mínimo fracionário.

## Endpoints

`GET /api/admin/market/sourcing/opportunities`

Retorna:

- `actionQueue`: ações agregadas por impacto/prioridade;
- `riskFlagBreakdown`: flags que mais bloqueiam o inventário;
- `providerBreakdown`: cobertura por provider;
- `topOpportunities`: melhores ativos bloqueados e a ação recomendada;
- `policyReviewReady`: quantidade de ativos tecnicamente completos que já podem ir para revisão de política.

`POST /api/admin/market/sourcing/refresh`

Agora sincroniza Carbonmark clássico + Klima/Carbonmark x402 em paralelo, reranqueia o inventário e devolve também o relatório de oportunidades.

## Regra de integridade

O Opportunity Engine é somente diagnóstico. A única autoridade para permitir uma venda como compensação continua sendo `evaluateAssetEligibility`.
