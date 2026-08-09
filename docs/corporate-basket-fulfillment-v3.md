# Corporate Basket Fulfillment v3

## Objetivo

Executar e comprovar, por leg, a aquisição e a aposentadoria dos créditos que sustentam um basket corporativo pago.

Pagamento e fulfillment são estados separados. O pagamento correto termina em `paid_awaiting_fulfillment`; nenhuma aquisição ou aposentadoria automática ocorre no webhook.

## Início

`POST /api/admin/demand/baskets/:id/fulfillment/start`

Só inicia quando:

- basket e payment status estão `paid_awaiting_fulfillment`;
- existe uma reserva `committed` para cada leg;
- cada reserva cobre exatamente o volume vendido;
- cada leg comercial permanece confirmada.

É criada uma leg de fulfillment para cada leg do basket.

## Aquisição

`POST /api/admin/demand/baskets/:basketId/fulfillment/legs/:legId/acquire`

A aquisição precisa cobrir exatamente o volume da leg e registra:

- referência da aquisição/pedido;
- transaction hash quando houver;
- evidence URL;
- quantidade adquirida.

Fulfillment parcial não habilita retirement final.

## Retirement

`POST /api/admin/demand/baskets/:basketId/fulfillment/legs/:legId/retire`

Requer aquisição integral prévia e retirement exatamente igual ao volume vendido.

É obrigatório registrar:

- retirement reference;
- beneficiário;
- e pelo menos uma evidência: registry URL, certificate URL ou transaction hash.

Cada leg preserva registry, projeto, vintage, aquisição, retirement, beneficiário e evidência próprios.

## Falha parcial

Qualquer leg pode ser marcada `review_required`.

Nesse estado:

- o fulfillment pai vira `review_required`;
- o basket vira `fulfillment_review_required`;
- não há conclusão parcial silenciosa;
- nenhuma alocação ECOT final é criada.

Depois da resolução operacional, a leg pode voltar para `pending_acquisition` ou `acquired`, de acordo com o que já foi comprovado.

## Finalização climática

`POST /api/admin/demand/baskets/:id/fulfillment/finalize`

Só funciona quando:

- 100% das legs estão `retired`;
- `retired_kg == requested_kg` em cada leg;
- a soma aposentada é exatamente o volume total do basket.

A finalização:

1. cria um bundle de evidências do basket;
2. calcula SHA-256 do bundle;
3. cria `corporate_basket_ecot_allocations` exatamente no volume aposentado;
4. transforma reservas `committed` em `consumed`;
5. marca o basket `fulfilled_climate`;
6. marca a oportunidade de demanda como `fulfilled`.

## Entrega ECOT

`POST /api/admin/demand/baskets/:id/fulfillment/deliver-ecot`

Só após a finalização climática. Marca a alocação como entregue e o basket como `completed`.

## Documentos

`POST /api/admin/demand/baskets/:id/documents`

Permite vincular uma vez no nível pai:

- `receipt`;
- `nfse`.

Assim não emitimos um recibo ou NFS-e por leg.

## Evidência pública

`GET /api/demand/baskets/:publicCode/evidence`

Expõe:

- beneficiário por nome;
- volume total e aposentado;
- projetos, registries e vintages;
- referências/links de aquisição e retirement;
- certificados;
- bundle SHA-256;
- alocação ECOT;
- documentos finais.

CPF/CNPJ e e-mail armazenados no bundle operacional não são expostos pela rota pública.

## Travas de banco

`guard_fulfillment_leg_volume` impede:

- aquisição acima do volume vendido;
- retirement acima do volume vendido;
- leg marcada `retired` sem retirement integral;
- leg `retired` sem retirement reference.

## Automação

Nesta versão a execução é deliberadamente assistida. O modelo está pronto para adapters programáticos futuros, mas provider execution não é disparado automaticamente.

Isso mantém a regra:

`pagamento capturado != compensação concluída`.

A compensação só é concluída após todas as aposentadorias terem evidência individual e integral.

## Relação com Payment v2

O Basket Payment continua duplamente desligado no Render. Este módulo fecha o caminho operacional necessário antes de qualquer teste live de cobrança corporativa.
