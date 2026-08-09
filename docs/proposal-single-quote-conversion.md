# Conversão de Proposta Corporativa para Quote

## Objetivo

Permitir que uma proposta corporativa integralmente coberta por um único ativo seja convertida em uma `quote_request` real sem pular as travas de elegibilidade e execução.

## Endpoint

`POST /api/admin/demand/proposals/:id/convert-single`

## Requisitos

- `checkout_mode = single_asset_quote`;
- cobertura integral;
- proposta não expirada;
- status `draft`, `sent` ou `accepted`;
- contato com e-mail;
- exatamente um item;
- ativo ainda ativo/elegível;
- estoque e mínimo ainda compatíveis;
- limite máximo do checkout single-asset: 10.000.000 kg.

## Fontes assistidas

Gold Standard e CFC/x402 elegíveis geram uma quote `requested` com:

- `automation_enabled=false`;
- `sourcing_status=manual_quote_pending`;
- sem `final_total`;
- sem checkout.

O custo/estoque precisa ser reconfirmado na fila de sourcing assistido antes da cobrança.

## Fontes automáticas genéricas

Somente `dynamic + confirmed + connected + estoque suficiente` pode gerar quote `quoted` com preço recalculado no momento da conversão.

## Adapters específicos

Ativos Carbonmark e qualquer rail x402 programática não são convertidos por esta rota, porque precisam passar pelo adapter de quote específico do provider.

A resposta retorna `PROVIDER_SPECIFIC_QUOTE_REQUIRED`, impedindo bypass da cotação/assinatura específica.

## Idempotência

A proposta guarda `converted_quote_id`. Chamadas repetidas devolvem a mesma quote em vez de criar duplicatas.

## Próxima etapa

Propostas multi-lote continuam `basket_quote_required`. O basket corporativo terá cobrança-pai e pernas independentes de sourcing/retirement; não é seguro simular isso com várias quotes desconectadas.
