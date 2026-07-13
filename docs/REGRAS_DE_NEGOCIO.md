# Regras de negócio

1. Um projeto somente pode gerar ECOT após verificação administrativa.
2. Cada número de série ou faixa de série deve ser único.
3. `tokenizedKg + retiredKg` nunca pode ultrapassar `totalKg`.
4. Um lote só pode ser vendido enquanto estiver ativo e possuir saldo.
5. Toda baixa de estoque ocorre dentro de uma transação PostgreSQL com trava de linha.
6. Hashes de blockchain ou IPFS só são gravados quando retornados por serviços reais.
7. Sem integração blockchain configurada, o lote é marcado como `offchain`.
8. A queima ou baixa interna de ECOT não substitui a aposentadoria no registro ambiental original.
9. Certificados devem indicar o projeto, o volume, a origem e a referência da aposentadoria coletiva.
10. ECOT não deve ser anunciado como investimento, moeda, CBE ou CRVE.
