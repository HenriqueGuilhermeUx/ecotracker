# Sourcing Gold Standard Marketplace

## Objetivo

Adicionar o Gold Standard Marketplace como terceira fonte comercial do Sourcing Engine, separando claramente três conceitos:

1. integridade/elegibilidade do crédito;
2. capacidade da fonte de aposentar o crédito e emitir evidência;
3. automação do checkout/execution no EcoTracker.

Um ativo pode ser elegível para compensação verificada e, ao mesmo tempo, exigir execução assistida.

## Fontes oficiais

O provider combina duas leituras públicas do próprio Gold Standard:

- `products.json`: produto, preço e metadados do storefront;
- `/collections/projects`: estoque publicado, vintages, localização e tipo de projeto.

O Gold Standard Marketplace informa publicamente que os créditos comprados são retirados no Gold Standard Impact Registry, que a Retirement Attribution pode ser atribuída a pessoa/empresa indicada pelo comprador e que o comprador recebe Retirement Certificate com links para os retirements.

A Commerce API ainda não está integrada ao EcoTracker.

## Política conservadora de estoque

A camada base nunca infere estoque de números soltos em HTML. A camada de enriquecimento só usa o padrão explícito publicado pelo catálogo oficial:

`In stock (N units)`

Como cada crédito representa 1 tCO2e, esse valor é armazenado como toneladas monitoradas.

Mesmo com estoque publicado, `availability_status` permanece `indicative` nesta fase porque a disponibilidade final precisa ser reconfirmada no momento da compra assistida. Isso também impede que o lote seja classificado como execução automática.

## Política de vintage

O catálogo oficial publica `VINTAGES: AAAA | AAAA | ...`.

Um produto só pode ser classificado como compensação verificada assistida quando:

- há estoque positivo publicado;
- todas as vintages declaradas estão dentro da política comercial EcoTracker;
- existe evidência pública do produto/registry;
- a fonte está conectada;
- o Gold Standard Marketplace está oferecendo o produto.

Quando há múltiplas vintages, a vintage mais antiga é usada como limite conservador para a política de idade. A unidade/vintage efetivamente aposentada deve ser confirmada no Retirement Certificate/Impact Registry antes do fulfillment final.

Produtos com qualquer vintage fora do limite continuam restritos; não fazemos cherry-picking de uma vintage recente dentro de um produto misto.

## Compensação verificada assistida

Quando todos os critérios acima são satisfeitos, o ativo recebe:

- `claim_category = voluntary_offset`;
- `eligibility_status = eligible`;
- `source_unit_status = tradable`;
- `retirement_supported = true`;
- `beneficiary_retirement_supported = true`;
- `retirement_granularity_kg = 1000`;
- `fractional_retirement_supported = false`;
- `quality_tier = verified-offset-assisted`;
- `pricing_mode = quote`;
- `availability_status = indicative`.

Isso significa **lote apto ao claim de compensação, mas com execução comercial assistida**.

Não significa que o EcoTracker possa comprar automaticamente. O Gold Standard é quem executa o retirement no Impact Registry e emite o certificado; o EcoTracker precisa confirmar o pedido e posteriormente vincular a evidência de retirement ao fulfillment.

## Cotações assistidas

A camada `assisted-quote-routes.ts` protege essas fontes.

Uma fonte genérica só pode gerar cotação automática quando simultaneamente:

- `pricing_mode = dynamic`;
- `availability_status = confirmed`;
- `source_status = connected`;
- `available_tons` é conhecido e positivo.

Gold Standard fica em `pricing_mode=quote` e `availability_status=indicative`, portanto gera somente solicitação `requested`, sem preço final travado e sem checkout automático.

Carbonmark clássico continua usando sua rota especializada de quote travado. x402 continua bloqueado para execução financeira.

## Enriquecimento e Autopilot

O enriquecimento roda:

- no boot, depois do refresh base do Gold Standard e antes do primeiro ranking;
- antes das leituras públicas do mercado;
- dentro do ciclo Gold Standard do Sourcing Autopilot;
- em worker periódico próprio.

O ciclo é atômico do ponto de vista do sourcing:

`refresh storefront -> enrich estoque/vintages -> rank`

Assim o coletor base nunca deixa os ativos temporariamente restritos entre refreshes.

## Endpoints

- `GET /api/market/gold-standard/status`
- `POST /api/admin/market/gold-standard/refresh`
- `GET /api/market/compensation-assets?kg=1000`

O campo público `execution_mode` diferencia `programmatic` de `assisted`.

## Próxima etapa

A próxima evolução do provider é integrar a Commerce API para transformar execução assistida em programática. Antes disso, toda compra Gold Standard deve manter confirmação humana/operacional de preço, estoque, attribution e certificado.
