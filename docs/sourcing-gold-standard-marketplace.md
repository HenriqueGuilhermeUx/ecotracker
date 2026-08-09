# Sourcing Gold Standard Marketplace

## Objetivo

Adicionar o Gold Standard Marketplace como terceira fonte comercial do Sourcing Engine, sem confundir catálogo público com execução automática.

## Fonte

O provider lê o storefront público do Gold Standard Marketplace e monitora:

- produto/projeto;
- preço por tonelada;
- disponibilidade do storefront;
- quantidade de estoque somente quando o payload público expõe `inventory_quantity` de forma consistente;
- vintages declaradas;
- tipo do projeto;
- link público do projeto/registry quando resolvido.

O Gold Standard também mantém Public API, Commerce API e Export API. Nesta fase o EcoTracker usa o storefront para sourcing comercial e mantém `GOLD_STANDARD_PUBLIC_API_BASE` preparado para enriquecimento registral futuro. A Commerce API ainda não foi integrada.

## Política conservadora de estoque

`available_tons` só recebe uma quantidade quando o payload público expõe inventário numérico para todas as variantes relevantes.

Se o storefront disser que o produto está disponível mas não expuser quantidade confiável:

- `available_tons = null`;
- `availability_status = indicative`;
- a cotação permanece assistida;
- nenhum checkout automático é liberado.

O EcoTracker não infere estoque a partir de textos, HTML ou números não estruturados.

## Política de vintage

O marketplace pode vender um produto com várias vintages sem permitir que o comprador escolha uma vintage individual.

Quando há múltiplas vintages:

- o ativo recebe a flag `gold-standard-vintage-selection-not-supported`;
- a política usa a vintage mais antiga como limite conservador;
- o ativo não entra automaticamente em compensação verificada;
- uma futura integração deverá vincular a unidade efetivamente alocada/aposentada antes de emitir qualquer claim final.

## Estado dos ativos nesta fase

Ativos Gold Standard Marketplace entram com:

- `pricing_mode = quote`;
- `claim_category = climate_contribution`;
- `eligibility_status = restricted`;
- `retirement_supported = false` no EcoTracker;
- `fractional_retirement_supported = false`;
- mínimo comercial padrão de 1 tonelada.

Isso não questiona a capacidade do Gold Standard de aposentar créditos vendidos pelo próprio marketplace. Significa apenas que o EcoTracker ainda não possui uma integração própria, automatizada e comprovável com a Commerce API para executar essa etapa.

## Cotações assistidas

A camada `assisted-quote-routes.ts` protege todas as fontes não executáveis automaticamente.

Uma fonte genérica só pode gerar cotação automática quando simultaneamente:

- `pricing_mode = dynamic`;
- `availability_status = confirmed`;
- `source_status = connected`;
- `available_tons` é conhecido e positivo.

Qualquer fonte `quote`, `indicative`, manual ou sem volume confirmado gera somente uma solicitação `requested`, sem `final_total` e sem checkout.

Carbonmark clássico continua usando sua rota especializada de quote travado. x402 continua bloqueado para execução financeira.

## Endpoints

- `GET /api/market/gold-standard/status`
- `POST /api/admin/market/gold-standard/refresh`

O Gold Standard também participa dos ciclos de:

- `/api/market/sourcing/status`;
- `/api/admin/market/sourcing/refresh`;
- Sourcing Autopilot;
- Opportunity Engine.

## Próxima etapa

A ação de maior valor para este provider é `integrate_gold_standard_commerce_api`.

Antes de habilitar execução automática, o EcoTracker precisa obter documentação/credenciais oficiais da Commerce API e implementar, com idempotência:

1. seleção/vinculação do lote e vintage efetivamente fornecidos;
2. preço executável para a quantidade pedida;
3. criação de pedido;
4. retirement com beneficiário;
5. confirmação registral;
6. certificado/comprovante;
7. somente então fulfillment ECOT.
