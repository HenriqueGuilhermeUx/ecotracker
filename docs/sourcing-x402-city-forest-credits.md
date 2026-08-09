# City Forest Credits via Klima/Carbonmark x402

## Objetivo

Habilitar uma fonte de compensação verificada fracionária a partir de 1 kg de CO2e sem ativar a execução financeira x402.

## Escopo elegível

O EcoTracker reconhece somente três projetos City Forest Credits de **Tree Preservation** que aparecem no discovery x402/Regen e estão explicitamente documentados no handbook da Klima:

- `C02-003` — Buena Vista Heights Conservation Area;
- `C02-004` — Harvey Manning Park Expansion;
- `C02-006` — St. Elmo Preservation Project.

Os project IDs do feed x402 aparecem compactados como `C02003`, `C02004` e `C02006` e são normalizados para os IDs canônicos acima.

Não existe regra genérica que transforme qualquer ativo `REGEN` em compensação. O allowlist é deliberadamente restrito a esses projetos conhecidos.

## Base de integridade

City Forest Credits mantém registry próprio e seus protocolos de Preservation emitem créditos **ex-post** depois da proteção/quantificação/verificação. O programa é ICROA-endorsed.

A integração Klima/Regen documenta que os créditos CFC ficam escrowed na Regen Network para emissão dos mirrored credits em Base e que o retirement em Base é sincronizado periodicamente ao registry canônico da Regen.

Há evidência pública de retirement fracionário de `REGEN-C02004-2021` via Carbonmark/Klima; o x402 declara mínimo de 0,001 t para créditos não-Puro.

## Critérios EcoTracker

Um dos três créditos CFC só recebe `voluntary_offset + eligible` quando todos os critérios abaixo são verdadeiros:

- project ID está na allowlist CFC acima;
- provider informa `isRegistered=true`;
- protocolo é Preservation;
- vintage está dentro da política EcoTracker;
- existe liquidez positiva;
- retirement é suportado pelo provider;
- fracionamento está habilitado em granularidade de 1 kg.

Quando aprovado:

- `quality_tier = verified-offset-assisted-fractional`;
- `claim_category = voluntary_offset`;
- `eligibility_status = eligible`;
- `source_unit_status = tradable`;
- `retirement_supported = true`;
- `fractional_retirement_supported = true`;
- `retirement_granularity_kg = 1`;
- `beneficiary_retirement_supported = true`;
- `pricing_mode = quote`;
- `availability_status = indicative`.

`availability_status=indicative` é intencional: o crédito pode ser elegível para compensação sem ser programaticamente executável pelo EcoTracker.

## Execução permanece assistida

`KLIMA_X402_EXECUTION_ENABLED=false` continua sendo a regra.

Para ativos x402 que continuam restritos, `POST /api/market/quotes` retorna `X402_EXECUTION_NOT_ENABLED`.

Para os CFC verificados, a rota deixa a solicitação seguir para a política de elegibilidade e depois para a camada de cotação assistida. O resultado é somente:

- quote request `requested`;
- sem `final_total` travado;
- sem checkout;
- sem assinatura EIP-712;
- sem USDC movimentado;
- sem retirement automático.

O cliente pode, portanto, solicitar 1 kg ou mais sem o EcoTracker fingir que a rail financeira está pronta.

## Ciclo de refresh

O x402 base refresh mantém todos os registries conservadoramente restritos. O CFC enrichment roda imediatamente depois dele no:

- boot;
- leituras públicas de mercado/x402;
- Sourcing Autopilot;
- refresh administrativo do provider.

A sequência correta é:

`x402 discover -> CFC enrichment -> sourcing rank`

## Próxima fase

A execução programática só poderá ser ativada depois que a divergência atual na documentação EIP-712/EIP-3009 do relay x402 estiver resolvida e testada. Até lá, os CFC são **verified + fractional + assisted**, nunca automatic.
