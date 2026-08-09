# EcoTracker Corporate Basket v1

## Objetivo

Preparar propostas corporativas multi-lote para uma futura cobrança única, sem habilitar pagamento antes que cada perna de sourcing esteja confirmada e auditável.

## Arquitetura

`proposta -> basket pai -> legs -> confirmação individual -> preço agregado`.

Nesta fase termina aqui. Pix/cartão permanecem desligados.

## Basket pai

`corporate_baskets` guarda:

- proposta e empresa;
- volume-alvo e volume coberto;
- custo agregado;
- receita de serviço;
- total comercial;
- preço por tonelada;
- validade global;
- snapshot do comprador e pricing;
- `payment_status=disabled`;
- `checkout_enabled=false`.

Existe trigger PostgreSQL que rejeita qualquer tentativa de habilitar checkout ou mudar o pagamento para estado ativo neste deployment.

## Legs

Cada `corporate_basket_leg` mantém separadamente:

- ativo/projeto/registry/vintage;
- quantidade em kg;
- provider;
- execution mode;
- custo-fonte confirmado;
- referência da fonte;
- estoque confirmado;
- evidence URL;
- validade da quote da fonte;
- snapshot de elegibilidade;
- snapshot de sourcing.

Cada leg é reavaliada pela `eligibility-policy` no momento da confirmação.

## Criação

`POST /api/admin/demand/proposals/:id/basket`

Só aceita proposta:

- `checkout_mode=basket_quote_required`;
- integralmente coberta;
- não expirada;
- ainda não convertida em quote single-asset;
- com itens ainda ativos, elegíveis e com estoque monitorado suficiente.

A criação é idempotente por `proposal_id`.

## Confirmação de leg

`POST /api/admin/demand/baskets/:basketId/legs/:legId/confirm`

Exige:

- custo real da fonte em BRL;
- referência de source/quote/order;
- estoque confirmado opcional, mas se informado precisa cobrir a leg;
- evidence URL opcional;
- TTL da confirmação.

A confirmação revalida:

- ativo ainda ativo;
- claim ainda elegível;
- estoque monitorado atual;
- estoque informado pela fonte.

## Fechamento de preço

Quando todas as legs estão confirmadas:

- `source_cost_brl = soma(custos das legs)`;
- fixed fees das fontes são agregadas;
- a `pricing-policy` EcoTracker é aplicada sobre o volume total;
- a validade global vira a menor validade entre todas as legs;
- status vira `quoted`;
- checkout continua desabilitado.

Se alguma leg expira antes do fechamento, o basket vira `expired`.

## Rotas

Admin:

- `POST /api/admin/demand/proposals/:id/basket`
- `GET /api/admin/demand/baskets`
- `GET /api/admin/demand/baskets/:id`
- `POST /api/admin/demand/baskets/:basketId/legs/:legId/confirm`
- `POST /api/admin/demand/baskets/:id/cancel`

Pública:

- `GET /api/demand/baskets/:publicCode`

A rota pública não expõe custo-fonte nem margem.

## Próxima fase

Basket v2 poderá habilitar:

1. reserva/lock das pernas;
2. uma cobrança-pai Pix/cartão;
3. webhook de pagamento do basket;
4. execução independente de source/retirement por leg;
5. bundle final de evidências;
6. recibo/NFS-e no nível pai, evitando documentos duplicados por leg.

Nenhum desses passos financeiros faz parte do v1.
