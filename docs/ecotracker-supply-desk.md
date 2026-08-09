# EcoTracker Supply Desk

## Tese

O EcoTracker Supply não origina nem revalida projetos do zero. A vertical distribui internacionalmente créditos já emitidos por projetos auditados e registrados.

Exemplo:

- projeto emitiu 543.000 tCO2e;
- 500.000 já foram vendidas, reservadas ou comprometidas;
- fornecedor confirma 43.000 tCO2e livres;
- um mandato autoriza o EcoTracker a distribuir até 43.000 tCO2e em canais como Carbonmark, Regen e OTC;
- o EcoTracker pode publicar o mesmo saldo em mais de um canal, mas reservas e vendas consomem um único saldo global.

## Duas verdades que nunca podem ser confundidas

### 1. Saldo potencial não aposentado

Dado derivado do registry, normalmente algo próximo de:

`emitido - aposentado - retirado/cancelado conhecido`

Esse valor serve para prospecção. Ele **não comprova disponibilidade comercial**. Créditos não aposentados podem já estar vendidos, reservados, prometidos em contratos OTC, sob exclusividade, transferidos para outro detentor ou destinados a aposentadoria futura.

No banco: `estimated_unretired_tonnes` + `availability_confidence=registry_estimate`.

### 2. Saldo comercialmente livre

Quantidade confirmada pelo fornecedor/detentor como livre para distribuição, idealmente com evidência, serial range/batch e mandato.

No banco: `confirmed_free_tonnes` + `availability_confidence=seller_confirmed`.

Somente essa segunda quantidade pode gerar um `supplier_mandate` e virar `supply_inventory`.

## Pipeline operacional

1. Scout: descobrir projeto com crédito emitido e saldo potencial não aposentado.
2. Qualify: identificar fornecedor/proponente/detentor e validar contato.
3. Confirm inventory: perguntar quanto do saldo está realmente livre, incluindo batch, vintage e serials.
4. Mandate: obter autorização de distribuição, preço piso, prazo, canais e exclusividade/não exclusividade.
5. Inventory: criar um lote autorizado no Supply Desk.
6. Channel listing: publicar em Carbonmark, Regen, OTC ou outro canal compatível.
7. Reservation: qualquer intenção vinculante trava quantidade no saldo global.
8. Settlement: venda reduz `sold_tonnes`; reserva cancelada devolve quantidade ao saldo global.

## Fontes de scouting prioritárias

### Puro Registry

Alta prioridade para Brasil. O registry publica projeto, fornecedor, país, créditos emitidos, créditos aposentados e transações. É adequado para calcular um **saldo potencial não aposentado** e montar uma lista de abordagem.

Exemplos públicos brasileiros identificados em agosto de 2026:

- Aperam BioEnergia / Aperam Bioenergia Ltda / projeto 175613: 161.507 CORCs emitidos e 97.459 aposentados. Diferença bruta: 64.048 tCO2e não aposentadas. Isso é um indicador de prospecção, não uma afirmação de estoque livre.
- NetZero-002-Lajinha / NetZero / projeto 141608: 5.211 emitidos e 4.411 aposentados. Diferença bruta: 800 tCO2e.
- NetZero-003-Brejetuba / NetZero / projeto 566645: 1.270 emitidos e 1.270 aposentados. Diferença bruta: zero; baixa prioridade de abordagem para inventário existente.

### ACR

Os Public Reports incluem Projects, Credits, Public Profiles e **Public Holdings**, além de logs de emissão/aposentadoria. É uma das melhores fontes para encontrar detentores com posição registrada. A disponibilidade comercial ainda deve ser confirmada.

### Verra

A Verra torna públicos registros de emissão e aposentadoria de VCUs e a informação dos projetos. A diferença entre emitido e aposentado é boa para detectar projetos com volume potencial, mas não equivale a saldo comercial livre. A nova Verra Registry entrou no ar em julho de 2026; adaptadores automáticos devem usar o contrato atual da nova plataforma, não depender de endpoints legados sem validação.

### Gold Standard

O Impact Registry é a fonte de verdade para créditos emitidos, mantidos, transferidos e aposentados e utiliza serial numbers para rastreabilidade. Public API, Commerce API e Export API estavam operacionais em julho de 2026. É candidata a scanner programático após validar contrato/autorização de uso.

### Climate Action Reserve

Boa fonte para projetos, emissões originais, serials, créditos aposentados e participantes comerciais. Porém a própria Reserve informa que não divulga o saldo de CRT em cada conta. Portanto é uma fonte de leads, não de saldo atual exato.

### Regen

Sell orders on-chain são sinal de inventário realmente colocado à venda: a ordem contém seller, batch, quantidade e ask price, e os créditos ficam em escrow. É excelente para descobrir estoque já Web3, mas não revela excedentes ainda parados em registries tradicionais.

### Carbonmark

É um canal de distribuição e também uma fonte de inteligência de mercado. Fornecedores podem listar créditos verificados, definir preço, sem exigência de exclusividade, e uma listagem alcança marketplace público, API enterprise e sales outreach. Inventário listado ali já está mais próximo de ser comercialmente executável do que um simples saldo de registry.

## Campos mínimos do lead

- registry;
- registry project ID;
- projeto;
- país/estado;
- fornecedor/proponente;
- contato;
- metodologia;
- vintage;
- créditos emitidos;
- créditos aposentados;
- retirados/cancelados conhecidos;
- saldo potencial não aposentado;
- URL de evidência;
- status de contato;
- saldo livre confirmado;
- preço piso;
- batch/serial ranges;
- canais autorizados;
- validade do mandato.

## API v1

- `GET /api/admin/supply/leads`
- `POST /api/admin/supply/leads`
- `POST /api/admin/supply/leads/:id/confirm-inventory`
- `POST /api/admin/supply/mandates`
- `GET /api/admin/supply/inventory`
- `POST /api/admin/supply/inventory/:id/allocate-channel`
- `POST /api/admin/supply/inventory/:id/reserve`
- `POST /api/admin/supply/reservations/:id/release`
- `POST /api/admin/supply/reservations/:id/settle`

## Proteções contra dupla venda

Uma publicação em vários canais não reserva créditos por si só. Ela é marketing/distribuição do mesmo estoque.

Quando existe ordem/reserva vinculante, `supply_reservations` trava quantidade contra o saldo global do `supply_inventory`. Uma trigger PostgreSQL impede que `sold_tonnes + reservas ativas` ultrapasse `authorized_tonnes`.

Outra trigger impede que a soma dos lotes criados sob um mandato ultrapasse a quantidade total autorizada pelo fornecedor.

Assim o modelo suporta distribuição multi-channel sem copiar economicamente o mesmo crédito duas vezes.
