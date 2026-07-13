# Deploy: Render + Netlify

## 1. PostgreSQL

Crie um banco PostgreSQL e copie a connection string externa para `DATABASE_URL` no Render.

## 2. Backend no Render

1. No Render, escolha **New > Blueprint** e selecione este repositório.
2. O arquivo `render.yaml` criará o serviço `ecotracker-api`.
3. Configure `DATABASE_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` e `FRONTEND_URL`.
4. O backend cria as tabelas automaticamente na primeira inicialização.
5. Confirme que `/api/health` retorna `{"status":"ok"}`.

Integrações opcionais:

- `PINATA_JWT`: upload real do certificado para IPFS.
- `POLYGON_RPC_URL`, `BLOCKCHAIN_PRIVATE_KEY` e `REGISTRY_CONTRACT_ADDRESS`: registro real do hash na Polygon.

## 3. Frontend no Netlify

1. Importe o mesmo repositório no Netlify.
2. O `netlify.toml` define `frontend` como base e `dist` como publicação.
3. Adicione `VITE_API_URL=https://SEU-BACKEND.onrender.com/api`.
4. Faça o deploy.
5. Volte ao Render e defina `FRONTEND_URL` com o domínio do Netlify.

## 4. Domínio

- `ecotracker.club` → Netlify.
- `api.ecotracker.club` → Render, quando desejar usar subdomínio próprio.
