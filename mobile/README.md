# EcoTracker Mobile

Aplicativo nativo React Native/Expo para compra e acompanhamento de créditos ambientais fracionados.

## Produto

O app possui cinco áreas principais:

- **Início**: recomendação de ECOT, fontes monitoradas e jornada operacional.
- **Mercado**: busca, filtros, atualização e ativos multi-registry.
- **Calcular**: estimativa pessoal ou corporativa de emissões.
- **Atividade**: histórico local de cotações e operações.
- **Conta**: dados de cotação, entrega por e-mail ou carteira e transparência.

Telas internas:

- detalhe do ativo;
- seleção de quantidade;
- solicitação de cotação;
- acompanhamento da operação;
- Pix e cartão;
- aquisição, aposentadoria e entrega;
- recibo e NFS-e.

## Segurança

- O app não armazena dados de cartão.
- Perfil e códigos de cotação são guardados com Expo SecureStore.
- O pagamento ocorre nos provedores configurados pelo backend.
- A entrega de ECOT só é apresentada após a aposentadoria.
- A API padrão é `https://ecotracker-api-cik7.onrender.com/api`.

## Android

Identificador:

```text
com.alternativeventures.ecotracker
```

Perfis EAS:

- `preview`: gera APK instalável diretamente.
- `production`: gera AAB para Google Play.

Scripts:

```text
npm run build:apk
npm run build:aab
```

Antes do primeiro build, o projeto precisa ser vinculado a uma conta Expo/EAS e receber um `projectId` em `app.json`.
