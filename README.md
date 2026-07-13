# EcoTracker

Infraestrutura brasileira para registrar o lastro de créditos de carbono, fracionar o benefício ambiental em unidades ECOT de 1 kg de CO₂e e distribuí-las por compra, recorrência ou programas de rewards.

## Estrutura

- `frontend/`: site público, marketplace e painel administrativo para Netlify.
- `backend/`: API Node/Express e PostgreSQL para Render.
- `contracts/`: contrato opcional de registro de hashes na Polygon.
- `docs/`: regras de negócio, implantação e roadmap.

## Regra central

**1 ECOT = 1 kg de CO₂e alocado a partir de um lote ambiental identificado.**

O ECOT é uma unidade interna de rastreabilidade e impacto. Não é apresentado como CBE, CRVE, valor mobiliário, investimento ou unidade oficial independente do registro ambiental de origem.

## Desenvolvimento local

```bash
npm install
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
npm run dev:api
npm run dev:web
```

Leia [`docs/DEPLOY.md`](docs/DEPLOY.md) para conectar Render e Netlify.
