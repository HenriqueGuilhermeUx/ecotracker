# EcoTracker — Launch Checklist

## Já implementado no produto
- [x] Home B2B orientada a compra de créditos de carbono
- [x] Marketplace público em PT-BR
- [x] Tradução amigável de projetos sem apagar o nome oficial
- [x] Formulário público de demanda corporativa
- [x] Matching automático ao receber demanda
- [x] RFQ automático quando faltar supply
- [x] Draft de proposta quando houver cobertura
- [x] Sell Desk ADM
- [x] Proposta comercial + revisão humana
- [x] Contrato/aceite
- [x] Privacy deletion backend
- [x] Política de Privacidade pública
- [x] Termos de Uso públicos
- [x] Página de contato institucional
- [x] Identificação Alternative Ventures/CNPJ no site
- [x] Alerta de novo lead por Resend quando configurado
- [x] Recibo transacional para o solicitante quando Resend estiver configurado
- [x] SEO/OG reposicionado para comprador corporativo
- [x] robots.txt + sitemap + favicon
- [x] Security headers no Netlify
- [x] Secret Guard e gates de execução segura

## Ações externas ainda necessárias
- [ ] Conectar domínio profissional ao Netlify (recomendado: domínio EcoTracker controlado pela empresa)
- [ ] Depois do domínio, atualizar canonical/OG/robots/sitemap e PUBLIC_APP_URL
- [ ] Configurar e verificar um domínio de envio no Resend
- [ ] Definir EMAIL_FROM no Render
- [ ] Definir ECOT_LEAD_NOTIFY_EMAIL no Render (ou garantir ECOT_LEGAL_EMAIL/ADMIN_EMAIL)
- [ ] Confirmar ECOT_LEGAL_NAME, ECOT_LEGAL_TAX_ID, ECOT_LEGAL_ADDRESS e ECOT_LEGAL_EMAIL no Render
- [ ] Criar/atualizar a página EcoTracker no LinkedIn
- [ ] Publicar o primeiro post do LinkedIn
- [ ] Fazer uma solicitação E2E real de teste pelo formulário público
- [ ] Validar que o lead aparece no Sell Desk e que o alerta chega por e-mail

## Gates que devem permanecer OFF no lançamento assistido
- CORPORATE_BASKET_PAYMENT_ENABLED=false
- CARBONMARK_ORDER_EXECUTION_ENABLED=false
- KLIMA_X402_EXECUTION_ENABLED=false
- ECOT_COMMERCIAL_OUTREACH_ENABLED=false até o dispatch real ser explicitamente autorizado
- ECOT_SUPPLY_OUTREACH_ENABLED=false até o dispatch real ser explicitamente autorizado
- WOOVI permanece fail-closed até rotação/reativação da credencial

## Modelo comercial de lançamento
Lançar como **desk corporativo assistido de créditos de carbono**.

Fluxo:
1. lead solicita volume;
2. EcoTracker faz matching/sourcing;
3. ADM revisa supply;
4. proposta comercial é aprovada;
5. cliente analisa origem/preço/volume;
6. contrato/aceite;
7. pagamento e execução são tratados de forma assistida enquanto os rails automáticos de produção permanecem bloqueados;
8. retirement/evidência concluem a operação climática.

Não esperar checkout automático para começar prospecção e fechamento assistido.
