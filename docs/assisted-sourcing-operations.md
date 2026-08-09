# Operação de sourcing assistido

## Objetivo

Permitir que créditos verificados sem rail programática completa sejam vendidos com controle humano, sem confundir elegibilidade ambiental com automação financeira.

## Fluxo

1. O cliente solicita uma cotação de um ativo `quote/indicative/manual`.
2. A cotação nasce como `requested`, `automation_enabled=false`, `sourcing_status=manual_quote_pending` e sem `final_total`.
3. Um administrador confirma custo real, estoque e referência da fonte em `POST /api/admin/market/assisted-sourcing/:id/confirm-source`.
4. O backend revalida a elegibilidade do lote e somente então grava o preço final e libera checkout.
5. Após o pagamento, jobs automáticos `source_asset` e `retire_asset` continuam bloqueados por trigger PostgreSQL.
6. A equipe executa a aquisição/aposentadoria no provider e registra a prova em `POST /api/admin/market/assisted-sourcing/:id/record-retirement`.
7. O registro da aposentadoria usa uma transação PostgreSQL única e persiste `retirement_proofs`.
8. Somente depois disso são enfileirados `deliver_ecot`, `issue_receipt` e `issue_nfse`.

## Endpoints administrativos

- `GET /api/admin/market/assisted-sourcing`
- `POST /api/admin/market/assisted-sourcing/:id/confirm-source`
- `POST /api/admin/market/assisted-sourcing/:id/record-retirement`

A fila retorna `nextAction` para cada operação: `confirm_source_quote`, `await_payment`, `execute_and_record_retirement`, `await_delivery` ou `complete`.

## Trava de banco

`ecotracker_guard_assisted_source_jobs()` intercepta inserções em `automation_jobs`. Se a cotação estiver com `automation_enabled=false` e o job for `source_asset` ou `retire_asset`, o job é persistido como `blocked`, com motivo auditável em `commerce_events`.

Essa defesa existe além da lógica de aplicação para impedir que um webhook ou worker futuro habilite sourcing/aposentadoria automática por acidente.

## Prova de aposentadoria

A tabela `retirement_proofs` guarda, por cotação:

- registry;
- referência de aposentadoria;
- transaction hash quando houver;
- beneficiário;
- quantidade em kg CO2e;
- URL de certificado/evidência;
- payload estruturado de auditoria.

A quantidade aposentada nunca pode ser inferior à quantidade vendida.

## Regra central

`verified` não significa `automatic`.

Gold Standard e CFC/x402 podem estar elegíveis para compensação e, ao mesmo tempo, continuar 100% assistidos até que uma rail de execução programática seja comprovada ponta a ponta.
