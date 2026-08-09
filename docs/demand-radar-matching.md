# EcoTracker Demand Radar + Matching Engine

## Objetivo

Conectar empresas brasileiras que publicam inventários corporativos de GEE a créditos de carbono elegíveis já disponíveis no EcoTracker.

O primeiro canal de descoberta é o Registro Público de Emissões (RPE) do Programa Brasileiro GHG Protocol/FGV.

## Regra contábil

O EcoTracker não subtrai offsets dos valores Scope 1, 2 ou 3 reportados pela empresa. O inventário permanece como inventário de emissões.

A compensação é tratada como uma operação separada e só é apresentada como tal quando:

- o crédito está elegível para `voluntary_offset`;
- a unidade está `tradable`;
- a fonte suporta retirement;
- existe evidência registral;
- o crédito é aposentado para o beneficiário que fará o claim;
- não existe dupla utilização/duplo claim.

## Estrutura

### Demand account

Representa a organização potencial compradora.

Fontes iniciais:

- `fgv_rpe`;
- manual;
- futuramente CDP, relatórios ESG e outras bases públicas.

### Demand inventory

Armazena o inventário por ano:

- Scope 1;
- Scope 2 location-based;
- Scope 2 market-based;
- Scope 3;
- emissões biogênicas;
- remoções;
- total reportado;
- nível/provedor de verificação;
- URL do inventário.

### Demand opportunity

Define quanto a empresa pode querer compensar. O alvo pode ser:

- customizado;
- Scope 1;
- Scope 1 + Scope 2;
- percentual de Scope 1 + Scope 2.

Scope 3 não é automaticamente assumido como obrigação de compensação.

### Matching Engine

Para cada oportunidade, o motor procura primeiro `monitored_assets` que passam pelo gate EcoTracker de compensação:

- `claim_category=voluntary_offset`;
- `eligibility_status=eligible`;
- `source_unit_status=tradable`;
- `retirement_supported=true`;
- estoque positivo;
- validade/revisão atual;
- granularidade compatível com o pedido.

O plano é montado de forma multi-lote quando necessário.

O ranking considera:

- sourcing score;
- preferência de registry;
- preferência geográfica;
- tipo/metodologia;
- preço máximo;
- execução programática ou assistida;
- retirement para beneficiário;
- fracionamento.

## Integração com EcoTracker Supply

O Matching Engine também consulta `supply_inventory` com mandato comercial ativo.

Esses lotes aparecem como `commercial_supply_pending_eligibility` enquanto não estiverem vinculados a um ativo que passe pela política EcoTracker.

Isso é proposital:

`mandato comercial != elegibilidade para claim`.

Depois da revisão de qualidade/registry, o lote pode ser incorporado à prateleira de compensação e então passa a ser usado automaticamente pelo matching.

## FGV RPE

Endpoints:

- `GET /api/admin/demand/fgv/status`
- `POST /api/admin/demand/fgv/import`

O adapter suporta importação estruturada de participantes e inventários e calcula um lead score inicial.

A automação de crawling está desligada até confirmarmos um contrato público estável da API do RPE. O host `registropublicodeemissoesapi.fgv.br` existe, mas endpoints privados/autenticados não são inferidos nem utilizados.

## API operacional

- `GET /api/admin/demand/accounts`
- `POST /api/admin/demand/accounts`
- `POST /api/admin/demand/accounts/:id/inventories`
- `GET /api/admin/demand/radar`
- `POST /api/admin/demand/accounts/:id/opportunities`
- `GET /api/admin/demand/opportunities`
- `POST /api/admin/demand/opportunities/:id/match`
- `GET /api/admin/demand/opportunities/:id/matches`

## Fluxo comercial

`FGV/RPE -> empresa -> inventário -> lead score -> oportunidade -> matching -> proposta -> cotação EcoTracker -> pagamento -> retirement -> evidência/certificado`.

Em paralelo:

`Verra/Puro/ACR/etc -> EcoTracker Supply -> saldo livre confirmado -> mandato -> listagem Carbonmark/Regen/OTC -> gate de elegibilidade -> Matching Engine`.

Assim o EcoTracker opera as duas pontas do mercado sem confundir inventário corporativo, crédito registral, tokenização e claim climático.
