# Operação de Sourcing Assistido

## Objetivo

Transformar lotes de compensação verificada com execução assistida em um fluxo operacional controlado, sem permitir aquisição ou retirement automáticos por engano.

## Ciclo

### 1. Solicitação do cliente

Ativos elegíveis cuja fonte não é programaticamente executável entram por `POST /api/market/quotes`.

A cotação nasce com:

- `status = requested`;
- `sourcing_status = manual_quote_pending`;
- `sourcing_provider` identificado;
- `automation_enabled = false`;
- sem `final_total`;
- sem checkout.

### 2. Confirmação da fonte

Admin usa:

`POST /api/admin/market/assisted-sourcing/:id/confirm-source`

É obrigatório informar:

- custo real confirmado da fonte em BRL;
- referência da fonte/pedido/quote;
- opcionalmente evidência URL e estoque confirmado.

O backend revalida a elegibilidade do ativo para a quantidade solicitada antes de aceitar a confirmação.

Só então:

- calcula markup/fee usando a política EcoTracker;
- grava custo e margem;
- define validade da cotação;
- muda para `status = quoted`;
- libera checkout;
- mantém `automation_enabled = false`.

### 3. Pagamento

O cliente usa o checkout normal depois que a fonte foi confirmada.

Mesmo após pagamento, aquisição e retirement automáticos permanecem proibidos para a cotação assistida.

### 4. Trava de banco

Há um trigger PostgreSQL em `automation_jobs`.

Se `quote_requests.automation_enabled = false`, qualquer tentativa de criar job:

- `source_asset`;
- `retire_asset`;

é convertida para `status = blocked` antes de entrar na fila executável.

O evento fica auditável em `commerce_events`.

Essa trava protege o fluxo mesmo que um webhook ou worker futuro tente enfileirar a operação automaticamente.

### 5. Retirement real

Depois que a equipe executa a compra/retirement no provider, usa:

`POST /api/admin/market/assisted-sourcing/:id/record-retirement`

O endpoint exige pagamento confirmado e registra:

- referência de sourcing;
- referência do retirement;
- tx hash quando existir;
- URL do certificado/evidência;
- quantidade aposentada;
- prova estruturada em `retirement_proofs`.

A quantidade aposentada não pode ser menor que a quantidade vendida.

### 6. Pós-retirement

Somente depois da prova de retirement o EcoTracker enfileira:

- `deliver_ecot`;
- `issue_receipt`;
- `issue_nfse`.

A trava de banco continua bloqueando source/retire automáticos, mas permite essas etapas posteriores.

## Fila operacional

`GET /api/admin/market/assisted-sourcing`

Retorna todas as operações assistidas abertas, priorizadas por urgência, com `nextAction`:

- `confirm_source_quote`;
- `await_payment`;
- `execute_and_record_retirement`;
- `await_delivery`;
- `complete`.

Para x402, a fila fornece também o endpoint de quote-preview; para Gold Standard, a URL pública da oferta.

## Regra de segurança

Compensação verificada e execução automática são conceitos independentes.

Um ativo pode ser verde/elegível e continuar 100% assistido. Nenhum pagamento deve ser liberado antes da confirmação da fonte, e nenhuma evidência/ECOT final deve ser entregue antes do retirement comprovado.
