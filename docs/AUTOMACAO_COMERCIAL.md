# EcoTracker — automação comercial

## O que o sistema executa

1. Monitora fontes e ordens ambientais.
2. Publica ofertas individuais da Regen quando o preço pode ser convertido.
3. Calcula custo da fonte, margem, taxa mínima e preço final.
4. Cria cotação com validade limitada.
5. Recebe Pix pela Woovi ou cartão pelo Mercado Pago Checkout Pro.
6. Confirma o pagamento por webhook, sem depender do navegador do cliente.
7. Registra receita, custo, taxas, reserva tributária e lucro estimado.
8. Cria uma fila auditável para aquisição, aposentadoria, entrega, recibo e NFS-e.
9. Entrega ECOT somente depois da aposentadoria registrada.
10. Gera recibo operacional e encaminha a NFS-e ao emissor fiscal configurado.

Nenhuma etapa bloqueada cria ECOT sem lastro. Quando um registry não oferece API executável, o job fica como `blocked` ou `awaiting_configuration` e pode ser concluído manualmente no painel.

## Configuração no Render

Abra o serviço `ecotracker-api`, entre em **Environment** e preencha os valores abaixo.

### Endereços públicos

```env
PUBLIC_APP_URL=https://ecotracker10.netlify.app
PUBLIC_API_URL=https://ecotracker-api-cik7.onrender.com
```

### Precificação

```env
ECOT_MIN_SERVICE_FEE_BRL=29.90
ECOT_QUOTE_TTL_MINUTES=15
ECOT_PIX_FEE_PCT=0
ECOT_CARD_FEE_PCT=0
ECOT_TAX_RESERVE_PCT=0
```

As taxas percentuais devem refletir o contrato real com o meio de pagamento e a orientação contábil da empresa. Enquanto estiverem zeradas, o painel não descontará esses custos do lucro estimado.

## Pix — Woovi

Crie uma chave de API da Woovi e configure:

```env
WOOVI_APP_ID=<chave da API>
WOOVI_WEBHOOK_SECRET=<segredo longo gerado no Render>
```

Cadastre na Woovi o webhook:

```text
https://ecotracker-api-cik7.onrender.com/api/webhooks/woovi/SEU_SEGREDO
```

Eventos necessários:

```text
OPENPIX:CHARGE_COMPLETED
OPENPIX:CHARGE_COMPLETED_NOT_SAME_CUSTOMER_PAYER
```

O sistema usa `correlationID` igual ao código da cotação e trata o evento de forma idempotente.

## Cartão — Mercado Pago Checkout Pro

Crie uma aplicação no Mercado Pago e configure:

```env
MP_ACCESS_TOKEN=<access token>
MP_USE_SANDBOX=true
```

Em produção, altere:

```env
MP_USE_SANDBOX=false
```

A URL de notificação é enviada automaticamente ao criar a preferência:

```text
https://ecotracker-api-cik7.onrender.com/api/webhooks/mercadopago
```

O backend consulta o pagamento diretamente no Mercado Pago e só considera pago quando o status retornado é `approved`.

## E-mail — Resend

```env
RESEND_API_KEY=<chave>
EMAIL_FROM=EcoTracker <contato@seu-dominio-verificado.com>
```

O domínio remetente precisa estar validado no provedor. Sem essa configuração, a entrega ECOT continua registrada, mas o job informa que o e-mail não foi enviado.

## Aquisição, aposentadoria e entrega on-chain

Essas etapas exigem uma carteira operacional, autorização do registry e assinatura segura. O backend não armazena uma lógica específica de um único registry; ele chama executores independentes, que podem ser fluxos n8n ou um signer service.

```env
SOURCE_EXECUTOR_URL=https://SEU-N8N/webhook/ecotracker-source
SOURCE_EXECUTOR_TOKEN=<segredo>
RETIREMENT_EXECUTOR_URL=https://SEU-N8N/webhook/ecotracker-retire
RETIREMENT_EXECUTOR_TOKEN=<segredo>
DELIVERY_EXECUTOR_URL=https://SEU-N8N/webhook/ecotracker-deliver
DELIVERY_EXECUTOR_TOKEN=<segredo>
```

### Resposta esperada do executor

Concluído:

```json
{
  "status": "completed",
  "reference": "identificador-no-registry",
  "txHash": "0x...",
  "retired": true
}
```

Ainda processando:

```json
{
  "status": "processing",
  "reference": "protocolo-da-operacao"
}
```

Bloqueado:

```json
{
  "status": "blocked",
  "reason": "carteira sem saldo ou autorização pendente"
}
```

Todos os requests incluem `idempotencyKey`, código da cotação, registry, quantidade e referências do ativo. O executor deve rejeitar repetição ou devolver o resultado já conhecido para a mesma chave.

## NFS-e

O EcoTracker não gera uma nota fiscal fictícia. A emissão requer cadastro municipal, certificado/credenciais e enquadramento tributário corretos.

Configure um emissor fiscal ou um fluxo n8n que converse com o emissor escolhido:

```env
NFSE_PROVIDER_URL=https://SEU-N8N/webhook/ecotracker-nfse
NFSE_PROVIDER_TOKEN=<segredo>
```

Resposta esperada:

```json
{
  "status": "completed",
  "reference": "numero-da-nfse",
  "documentUrl": "https://.../nota.pdf"
}
```

Sem essa configuração, o EcoTracker gera o recibo operacional e mantém a NFS-e como `awaiting_configuration`.

## Operação manual de contingência

No endereço:

```text
https://ecotracker10.netlify.app/#market-admin
```

A aba **Operações** permite:

- informar custo confirmado e preço final;
- visualizar lucro bruto e líquido estimado;
- confirmar aquisição manualmente;
- registrar referência ou hash de aposentadoria;
- confirmar entrega;
- acompanhar pagamento, recibo e NFS-e.

A aba **Automações** mostra tentativas, erros e permite reenfileirar jobs bloqueados ou com retry.

## Segurança

- Não coloque chaves privadas no frontend ou GitHub.
- Chaves e tokens ficam somente no Render ou no cofre do n8n.
- Use uma carteira operacional separada e com saldo limitado.
- O signer service deve validar registry, lote, quantidade máxima, destinatário e idempotency key.
- O pagamento não implica emissão imediata; primeiro ocorre aquisição e aposentadoria.
- OFP e Coorest permanecem em cotação assistida até existir integração executável autorizada.
