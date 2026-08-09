# Corporate Basket — Reservas Atômicas

## Objetivo

Adicionar lock local de inventário antes de qualquer futura cobrança corporativa multi-lote.

A reserva não compra nem aposenta créditos e não substitui a confirmação do provider. Ela impede que o próprio EcoTracker comprometa localmente o mesmo estoque para dois baskets ao mesmo tempo.

## Pré-condições

Um basket só pode ser reservado quando:

- status `quoted` ou uma reserva anterior ainda válida;
- todas as legs estão `confirmed`;
- custo, referência e **estoque confirmado** existem em cada leg;
- a confirmação de cada leg ainda está válida;
- o basket ainda está dentro da validade;
- cada ativo continua elegível;
- o estoque atual ainda cobre o volume.

## Atomicidade

`POST /api/admin/demand/baskets/:id/reserve`

A operação acontece em uma única transação PostgreSQL:

1. expira reservas antigas;
2. bloqueia o basket;
3. bloqueia legs e ativos em ordem determinística;
4. revalida elegibilidade e estoque;
5. cria/reativa uma reserva por leg;
6. somente se **todas** funcionarem o basket vira `reserved`.

Se qualquer leg falhar, a transação inteira é revertida.

## Capacidade efetiva

Para cada ativo, o PostgreSQL calcula:

`capacidade efetiva = min(estoque monitorado, estoque confirmado da leg)`

Se um dos dois não existir, usa o conhecido. Nesta fase, entretanto, o endpoint de confirmação exige explicitamente `sourceAvailableKg`, então existe sempre confirmação operacional antes da reserva.

O trigger soma todas as reservas locais ativas e não vencidas do mesmo ativo e impede:

`reservado atual + nova reserva > capacidade efetiva`.

## Reserva local vs provider

A reserva é deliberadamente marcada como local.

Ela não significa que Carbonmark, Gold Standard, Regen ou outro marketplace tenha bloqueado externamente as unidades. Antes da futura cobrança, o Basket v2 deverá executar um **pre-payment provider recheck** e, quando o provider suportar, um lock/order externo.

## Janela

A reserva padrão é 15 minutos, configurável pela chamada entre 5 e 120 minutos.

O `reserved_until` nunca ultrapassa:

- a validade agregada do basket;
- a menor validade das legs;
- a janela pedida.

## Repricing

Enquanto o basket está `reserved`, um trigger PostgreSQL impede alteração de:

- custo da leg;
- referência da fonte;
- estoque confirmado;
- evidência;
- validade;
- ativo;
- volume.

Para alterar qualquer um deles é obrigatório liberar a reserva primeiro.

## Release

`POST /api/admin/demand/baskets/:id/release`

Libera todas as reservas ativas atomicamente. Se a quote continuar válida, o basket volta para `quoted`; caso contrário fica `expired`.

## Segurança financeira

O trigger de Basket v1 continua ativo:

- `checkout_enabled=false`;
- `payment_status=disabled`.

Portanto reserva de inventário não habilita cobrança.

## Próxima fase

A rail de pagamento só poderá ser ligada depois de:

1. pre-payment provider recheck;
2. payment parent idempotente;
3. webhook específico para basket;
4. legs de source/retirement independentes;
5. tratamento de falha parcial;
6. bundle de evidências;
7. recibo/NFS-e no nível pai, sem duplicidade documental.
