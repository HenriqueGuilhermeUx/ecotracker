# Sourcing Engine v1.1

## Objetivo

Alinhar a configuração efetiva do Render com o Sourcing Engine v1 e reduzir carga no Postgres durante leituras frequentes do marketplace.

## Alterações

- `CARBONMARK_PUBLISHED_LISTING_LIMIT`: 100 no Render.
- `ECOT_MIN_VERIFIED_OFFSET_ASSETS`: 5 no Render.
- `ECOT_SOURCING_RANK_MAX_AGE_MS`: 60000 ms.
- ranking persiste todos os ativos em um único `UPDATE ... FROM UNNEST(...)`.
- requisições repetidas dentro da janela de 60s reaproveitam o ranking persistido.
- refresh administrativo da Carbonmark força reranking imediato com `maxAgeMs=0`.

## Segurança

Nenhuma regra de elegibilidade foi relaxada. A separação entre compensação verificada, contribuição climática e restrito continua sendo definida pelo `evaluateAssetEligibility`.
