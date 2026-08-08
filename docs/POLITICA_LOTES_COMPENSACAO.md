# Política EcoTracker para lotes, validade e claims

## Objetivo

O EcoTracker separa claramente créditos aptos à compensação voluntária de ativos usados apenas para contribuição climática/ecológica. Estar on-chain, ter preço ou ter vintage não é suficiente para habilitar um lote como compensação.

## Prateleiras

### 1. Compensação Verificada

Só entra nesta prateleira um lote com:

- `claim_category=voluntary_offset`;
- `eligibility_status=eligible`;
- unidade de origem confirmada como `tradable`;
- evidência pública do registry/projeto/lote;
- aposentadoria executável configurada;
- validade comercial EcoTracker futura;
- revisão de elegibilidade dentro da janela definida;
- pedido compatível com a granularidade real de aposentadoria;
- vintage dentro da política comercial ou exceção documentada.

A validade comercial EcoTracker é uma regra de curadoria e risco do marketplace. Ela não afirma que o registry tenha declarado o crédito “vencido”.

### 2. Contribuição Climática / Ecológica

Ativos reais podem permanecer nesta prateleira quando geram impacto ambiental, mas não possuem evidência suficiente para um claim de compensação. Isso inclui, por padrão, ordens genéricas monitoradas na Regen Network, Open Forest Protocol e Coorest até que projeto, metodologia, unidade e finalidade de uso sejam revisados.

Esses ativos nunca devem ser descritos ao comprador como equivalentes automáticos a um VCU, GSVER ou unidade regulatória.

### 3. Uso Restrito / Histórico

Lotes com oferta expirada, unidade aposentada/cancelada/suspensa, revisão desatualizada, vintage fora da política sem exceção, ou ausência de evidência ficam fora da compra para compensação.

Eles podem permanecer no admin para auditoria e histórico.

### 4. Compliance

CORSIA, Artigo 6 ou qualquer mercado regulado são uma trilha separada. Um lote voluntário não é promovido para compliance por inferência. A habilitação depende de atributo explícito e documentação aplicável.

## Política de vintage

O padrão inicial EcoTracker considera `ECOT_MAX_OFFSET_VINTAGE_AGE_YEARS=5` como limite comercial para a prateleira principal de compensação. Isso é uma política interna de qualidade e comercialização, não uma regra universal dos standards.

Exceções são permitidas somente com:

- `vintage_policy_override=true`;
- motivo documentado em `vintage_exception_reason`;
- revisão explícita do lote.

## Revisão periódica

A elegibilidade deve ser reconfirmada. O padrão inicial é `ECOT_ELIGIBILITY_MAX_AGE_HOURS=168` (7 dias). Após esse período, o lote deixa de ser automaticamente comprável para compensação até nova revisão.

## Fracionamento

Créditos tradicionais normalmente representam 1 tCO2e. O EcoTracker não deve fingir que uma fonte permite aposentadoria de 1 kg quando ela não permite.

Cada ativo possui:

- `fractional_retirement_supported`;
- `retirement_granularity_kg`.

Se a fonte aposenta somente em blocos de 1.000 kg, pedidos fracionados são bloqueados para a prateleira de compensação até existir um fornecedor/arranjo que suporte aposentadoria fracionária de forma legítima.

## Canais de abastecimento

O banco mantém canais operacionais separados dos lotes:

1. **Carbonmark API** — alvo preferencial para varejo fracionado porque oferece cotação e aposentadoria programática e declara suporte a quantidades fracionárias. Produção depende de onboarding/chave própria.
2. **Gold Standard Marketplace** — canal para unidades certificadas e aposentadoria; útil para estoque/compra direta e operação de 1 t ou múltiplos.
3. **Verra / parceiro de registry** — canal de alta aceitação para VCUs, com aposentadoria no registry. Não tokenizar ou criar instrumento relacionado a VCU sem observar os Termos da Verra e eventual consentimento.

## Meta de disponibilidade

`ECOT_MIN_VERIFIED_OFFSET_ASSETS` define quantos lotes elegíveis queremos manter simultaneamente. O padrão inicial é 2.

A rota `/api/market/availability` retorna:

- quantidade de lotes de compensação verificada;
- quantidade de lotes com compra fracionária real;
- quantidade de ativos de contribuição climática;
- alerta `needsReplenishment`;
- alerta `needsFractionalSource`;
- situação dos canais de abastecimento.

## Claim ao cliente

Para compensação voluntária, o recibo deve apontar para o ativo efetivamente aposentado e seu beneficiário/razão de aposentadoria quando disponível.

Para contribuição climática, a linguagem deve ser: “contribuição”, “apoio”, “impacto climático/ecológico” ou equivalente — nunca “compensou X kg” sem uma aposentadoria elegível correspondente.

O EcoTracker não apresenta ECOT como investimento, promessa de retorno, ativo especulativo ou substituto automático de instrumentos regulados.
