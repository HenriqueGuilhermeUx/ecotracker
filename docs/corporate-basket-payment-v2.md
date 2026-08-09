# Corporate Basket Payment v2

## Estado

**Implementado no backend, desativado por padrão.**

O deployment só aceita criação de checkout quando duas condições independentes são verdadeiras:

- `CORPORATE_BASKET_PAYMENT_ENABLED=true`;
- `CORPORATE_BASKET_PAYMENT_ACK=ENABLE_LIVE_BASKET_PAYMENTS`.

No `render.yaml`, ambas permanecem deliberadamente desligadas.

## Pré-condições para checkout

Antes de abrir Pix/cartão, o backend exige:

1. basket em `reserved`;
2. preço final agregado válido;
3. reserva e quote ainda dentro da validade;
4. pelo menos 120 segundos restantes de janela;
5. todas as legs confirmadas;
6. uma reserva local integral por leg;
7. estoque confirmado da fonte cobrindo cada leg;
8. elegibilidade atual revalidada para cada ativo;
9. estoque monitorado atual ainda suficiente.

Esse é o pre-payment recheck.

## Expiração alinhada à reserva

Um checkout não pode sobreviver à reserva que sustenta o basket.

- Woovi recebe `expiresIn` igual ou inferior ao tempo restante;
- Mercado Pago recebe `expiration_date_to` igual ao hard expiry do basket;
- o hard expiry é o menor entre `reserved_until` e `quote_expires_at`.

Se a reserva expirar enquanto o provider cria o checkout, o link não é exposto ao cliente.

## Payment parent

Cada basket possui tentativas próprias em `corporate_basket_payment_attempts`.

A referência externa é:

`basket:<public_code>`

Isso permite aos webhooks existentes diferenciar basket corporativo de quote comum sem criar endpoints externos paralelos.

## Webhook routing

Interceptors são registrados antes das rotas normais de commerce:

- Woovi: `/api/webhooks/woovi/:secret`;
- Mercado Pago: `/api/webhooks/mercadopago`.

Se a correlação não começar por `basket:`, o request segue via `next()` para o fluxo original de quotes.

O fluxo existente de pagamentos single-asset permanece independente.

## Reconciliação financeira

Ao receber confirmação do provider, o backend:

1. bloqueia basket e tentativa de pagamento;
2. compara valor esperado e valor efetivamente pago, tolerância de R$ 0,01;
3. verifica as reservas de todas as legs;
4. permite uma janela de reconciliação padrão de 5 minutos para atraso de webhook;
5. converte reservas locais em `committed` para que continuem consumindo capacidade;
6. grava fee, tax reserve e lucro líquido;
7. registra evento auditável.

### Divergência

Qualquer uma das situações abaixo leva a `payment_review_required`:

- valor pago diferente;
- webhook fora da janela de reconciliação;
- reservas incompletas;
- falha inesperada ao consolidar reservas.

A consolidação usa `SAVEPOINT`: uma falha na reserva não apaga a evidência do pagamento capturado.

## Pagamento correto

Quando valor e reservas reconciliam:

- payment attempt -> `paid`;
- basket -> `paid_awaiting_fulfillment`;
- reservas -> `committed`;
- checkout -> desabilitado.

**Nenhum source, retirement, delivery, recibo ou NFS-e é iniciado automaticamente nesta versão.**

Isso é uma fronteira deliberada: dinheiro capturado e fulfillment multi-leg são estados distintos.

## Proteção contra drift pós-pagamento

Depois que um checkout foi aberto, o estoque monitorado de um marketplace pode mudar antes do webhook chegar.

O trigger PostgreSQL não rejeita a transição de uma reserva previamente aprovada para `committed` durante reconciliação válida. Rejeitar essa transição depois do pagamento seria pior: teríamos dinheiro capturado sem registrar corretamente a obrigação.

A etapa seguinte deverá resolver qualquer indisponibilidade externa como exceção operacional de fulfillment, nunca apagando ou negando o pagamento ocorrido.

## Rotas

Públicas:

- `POST /api/demand/baskets/:publicCode/checkout`
- `GET /api/demand/baskets/:publicCode/payment`

Admin:

- `GET /api/admin/demand/basket-payments/status`
- `GET /api/admin/demand/basket-payments/attempts`

## Ativação

Não ativar produção apenas alterando código.

Antes de habilitar as duas flags:

1. CI PostgreSQL verde;
2. deploy com feature desligada validado;
3. teste Woovi sandbox/valor mínimo;
4. teste Mercado Pago sandbox;
5. webhook duplicado/idempotência;
6. webhook atrasado;
7. amount mismatch;
8. reserva expirada;
9. confirmação de que nenhum fulfillment foi iniciado;
10. Basket Fulfillment v3 implementado para source/retirement por leg e tratamento de falha parcial.

Até lá, `CORPORATE_BASKET_PAYMENT_ENABLED=false` e `CORPORATE_BASKET_PAYMENT_ACK=DISABLED`.
