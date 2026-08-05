# Segurança dos dados — respostas recomendadas para a Play Console

Estas respostas refletem a versão 1.0.1 do app EcoTracker e precisam ser revisadas sempre que SDKs, analytics, anúncios, pagamentos ou autenticação forem alterados.

## Visão geral

- **O app coleta ou compartilha dados?** Sim, coleta dados necessários a cotações e operações.
- **Os dados são criptografados em trânsito?** Sim, a API e páginas usam HTTPS.
- **O usuário pode solicitar exclusão?** Sim.
- **URL de exclusão:** https://ecotracker10.netlify.app/delete-account/
- **O app permite criação de conta?** Não na versão atual. Não existe senha nem conta autenticada; há um perfil local e cotações identificadas por UUID.
- **Anúncios:** Não.
- **Localização, contatos, câmera, microfone, SMS ou chamadas:** Não coletados e não solicitados.

## Tipos de dados coletados

### Informações pessoais

**Nome**
- Coletado: sim, quando o usuário preenche o perfil ou uma cotação.
- Finalidade: funcionalidade do app, gestão da operação e suporte.
- Obrigatório: necessário para cotações/recibos, não para navegar no catálogo.
- Compartilhamento: somente com prestadores necessários à operação, conforme política.

**Endereço de e-mail**
- Coletado: sim.
- Finalidade: identificar cotação, entregar status/comprovantes e suporte.
- Obrigatório: para solicitar cotação.

**Número de telefone**
- Coletado: opcional.
- Finalidade: contato e suporte operacional.

**Identificador fiscal (CPF/CNPJ)**
- Coletado: opcional na cotação; pode ser exigido para faturamento.
- Finalidade: documentos fiscais, prevenção a fraude e conformidade.

**Empresa**
- Coletado: opcional.
- Finalidade: proposta corporativa, faturamento e EcoRewards.

### Informações financeiras

**Histórico de compras e pagamentos**
- Coletado: sim quando o usuário inicia ou conclui pagamento.
- Conteúdo: valor, método, status, referência do provedor, taxas e comprovantes.
- Não coletado pelo EcoTracker: número completo do cartão e código de segurança.
- Finalidade: processar pagamento, conciliar, reembolsar, prevenir fraude e cumprir obrigações legais.

### Atividade no app

**Interações com o app**
- Coletado somente quando necessário ao serviço: projeto escolhido, quantidade, finalidade, forma de entrega, status e histórico da operação.
- Não há SDK de publicidade ou analytics comportamental na versão atual.

### Informações e desempenho do app

**Diagnóstico**
- Provedores de infraestrutura podem manter logs técnicos mínimos para disponibilidade, segurança e investigação de erros.
- Não há SDK dedicado de crash analytics na versão atual.

### Outros dados

**Endereço de carteira blockchain**
- Coletado somente se o usuário escolher entrega Web3.
- Finalidade: entrega técnica e prova on-chain.
- Endereços e transações em blockchain podem ser públicos; dados pessoais não devem ser gravados diretamente na blockchain.

**Estimativa de emissões**
- A calculadora usa números informados pelo usuário e armazena localmente a recomendação final.
- Não é dado de saúde nem localização.

## Compartilhamento com terceiros

Os seguintes fornecedores podem receber dados como prestadores de serviço, somente quando a funcionalidade correspondente estiver ativa:

- Woovi/OpenPix: Pix;
- Mercado Pago: cartão e checkout;
- registries, projetos e fornecedores: aquisição/aposentadoria;
- redes blockchain: endereço e transação pública, quando usados;
- Render e PostgreSQL: API e banco de dados;
- Netlify: site e páginas legais;
- Expo/EAS e Google Play: compilação, distribuição e integridade do app;
- Resend ou outro provedor de e-mail: mensagens transacionais;
- emissor de NFS-e: dados fiscais necessários.

Revisar a definição da Play Console sobre “compartilhamento”: transferências a prestadores que atuam exclusivamente em nome do desenvolvedor podem ter tratamento específico no formulário, mas todos os fluxos devem permanecer descritos na Política de Privacidade.

## Segurança e exclusão

- Perfil local armazenado com Expo SecureStore.
- Comunicação com backend via HTTPS.
- Opção interna: Conta → Privacidade e dados → Apagar dados deste aparelho.
- Opção externa: https://ecotracker10.netlify.app/delete-account/
- Dados não obrigatórios são apagados ou anonimizados.
- Registros fiscais, de pagamentos, antifraude, aposentadoria e entrega podem ser retidos pelo prazo legal informado na Política de Privacidade.

## Conteúdo financeiro e blockchain

- Declarar que o app possui conteúdo/funcionalidade baseada em blockchain.
- O ECOT não é promovido como investimento, ativo de rendimento ou promessa de valorização.
- Não declarar empréstimos, investimentos, exchange, custódia ou corretagem se essas funções não estiverem disponíveis.
- Pagamentos representam contratação de serviço/impacto ambiental e devem seguir as políticas de pagamento aplicáveis ao canal de distribuição.
