# ACR Public Holdings Supply Scout

## Objetivo

Usar os relatórios públicos do ACR como radar de detentores e saldos registrais ativos que podem virar mandato comercial do EcoTracker Supply.

## Fonte

O ACR publica relatórios de:

- Projects;
- Credits;
- Public Profiles;
- Public Holdings;
- CORSIA cancellations;
- retirement/issuance logs.

O próprio ACR informa que a contratação de compra ou retirement ocorre diretamente entre comprador e vendedor em transações OTC, ou em plataformas vinculadas aprovadas. Depois, transferência/retirement é registrado no registry.

## Interpretação correta

`Public Holdings` é um sinal mais forte que simplesmente `issued - retired`, porque representa créditos ativos visíveis em holdings públicos.

Ainda assim:

`public holding != commercial free inventory`.

O holder pode ter contratos OTC, reservas, exclusividade, opções ou outras obrigações comerciais não refletidas no relatório.

Por isso o EcoTracker grava o volume como `estimated_unretired_tonnes` + `availability_confidence=registry_estimate` até contato e confirmação.

## Importação

O adapter recebe linhas estruturadas do Public Holdings export/report e agrupa por projeto:

- holder atual;
- projeto;
- país/região;
- metodologia/tipo;
- vintage;
- toneladas ativas;
- serial ranges;
- labels CORSIA/CCP/removal quando fornecidas;
- perfil público/evidência.

Depois cria/atualiza `supply_leads`.

## Endpoints

- `GET /api/admin/supply/scout/acr/status`
- `POST /api/admin/supply/scout/acr/import`
- `GET /api/admin/supply/scout/acr/candidates`

## Fluxo

`ACR Public Holdings -> holder/projeto -> lead -> confirmação de saldo livre -> mandato -> Supply Inventory -> Carbonmark/Regen/OTC/direct -> venda -> registro da transferência/retirement no registry`.

A mesma quantidade pode ser anunciada em vários canais, mas existe um único saldo econômico no Supply Desk e as reservas globais impedem double selling.
