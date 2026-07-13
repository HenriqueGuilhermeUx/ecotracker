import { FormEvent, useEffect, useMemo, useState } from "react";
import { api } from "./api";

type Batch = {
  id: number;
  project_name: string;
  registry: string;
  registry_id: string;
  vintage?: string;
  location?: string;
  available_tokens: number;
  price_per_token: string;
  chain_status: string;
};

type Project = {
  id: number;
  name: string;
  registry: string;
  registry_id: string;
  total_kg: number;
  tokenized_kg: number;
  retired_kg: number;
  verification_status: string;
  certificate_sha256?: string;
  ipfs_cid?: string;
};

type Order = {
  id: number;
  buyer_email: string;
  buyer_name?: string;
  token_amount: number;
  total_price: string;
  payment_status: string;
  delivery_status: string;
  project_name: string;
};

type FootprintInputs = {
  people: number;
  flights: number;
  vehicles: number;
};

type CalculatorMode = "corporate" | "personal";

const money = (value: number | string) =>
  Number(value).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

const num = (value: number | string) => Number(value).toLocaleString("pt-BR");

export default function App() {
  const [page, setPage] = useState(location.hash.replace("#", "") || "home");

  useEffect(() => {
    const handleHashChange = () => setPage(location.hash.replace("#", "") || "home");
    addEventListener("hashchange", handleHashChange);
    return () => removeEventListener("hashchange", handleHashChange);
  }, []);

  return (
    <>
      <Header />
      <main>
        {page === "admin" ? (
          <Admin />
        ) : page === "marketplace" ? (
          <Marketplace />
        ) : page === "planos" ? (
          <Plans />
        ) : page === "rewards" ? (
          <Rewards />
        ) : (
          <Home />
        )}
      </main>
      <Footer />
    </>
  );
}

function Header() {
  return (
    <header>
      <a className="brand" href="#home" aria-label="EcoTracker — página inicial">
        <span>eco</span>tracker
      </a>
      <nav>
        <a href="#home">Protocolo</a>
        <a href="#marketplace">Comprar</a>
        <a href="#planos">Plano mensal</a>
        <a href="#rewards">EcoRewards</a>
        <a className="ghost" href="#admin">Admin</a>
      </nav>
    </header>
  );
}

function Home() {
  return (
    <>
      <section className="hero protocol-hero">
        <div className="hero-copy">
          <div className="eyebrow">ECOTRACKER — CARBON TOKENIZATION PROTOCOL</div>
          <h1>Tokens de<br /><em>Crédito Carbono</em></h1>
          <p>
            Zere suas emissões de forma simples. Através dos tokens ECOT, você neutraliza exatamente
            o que precisa, com lastro auditado e registro na blockchain Base.
          </p>
          <div className="actions">
            <a className="button" href="#marketplace">Explorar tokens ECOT</a>
            <a className="button secondary" href="#calculator">Calcular minha pegada</a>
          </div>
          <div className="hero-trust">
            <span>1 ECOT = 1 kg CO₂e</span>
            <span>Lastro por lote</span>
            <span>Prova criptográfica</span>
          </div>
        </div>

        <div className="protocol-panel" aria-label="Fluxo do protocolo EcoTracker">
          <div className="terminal-head">
            <span className="terminal-dot" />
            <span>ECOT / PROTOCOL STATUS</span>
            <b>BASE</b>
          </div>
          <div className="token-visual">
            <div className="token-orbit"><div className="token-core">ECOT</div></div>
            <small>CARBON-BACKED UNIT</small>
          </div>
          <div className="protocol-stats">
            <div><small>UNIDADE</small><strong>1 kg CO₂e</strong></div>
            <div><small>REDE</small><strong>Base</strong></div>
            <div><small>LASTRO</small><strong>Auditável</strong></div>
            <div><small>DOCUMENTO</small><strong>IPFS</strong></div>
          </div>
        </div>
      </section>

      <section className="delivery-section">
        <div className="section-heading">
          <span className="tag">ENTREGA INTELIGENTE</span>
          <h2>Como você recebe seus tokens?</h2>
          <p>
            Removemos a barreira de entrada da Web3. O protocolo foi desenhado para compras via Pix
            ou cartão, com entrega adequada ao perfil de cada cliente.
          </p>
        </div>
        <div className="delivery-grid">
          <article className="delivery-card">
            <div className="delivery-icon">@</div>
            <span className="delivery-badge">WEB2</span>
            <h3>Via E-mail</h3>
            <p>
              Criamos uma carteira digital segura vinculada ao seu e-mail automaticamente. Você
              acompanha seus ECOT sem precisar configurar uma carteira cripto.
            </p>
            <ul>
              <li>Entrada simples</li>
              <li>Custódia vinculada à conta</li>
              <li>Histórico de impacto</li>
            </ul>
          </article>
          <article className="delivery-card featured">
            <div className="delivery-icon">0x</div>
            <span className="delivery-badge">WEB3</span>
            <h3>Carteira Própria</h3>
            <p>
              Informe seu endereço 0x... e, quando a entrega on-chain estiver habilitada para o lote,
              os tokens são transferidos diretamente para sua carteira na Base.
            </p>
            <ul>
              <li>Autocustódia</li>
              <li>Registro on-chain</li>
              <li>Rastreabilidade por lote</li>
            </ul>
          </article>
        </div>
      </section>

      <section className="ipfs-section">
        <div>
          <span className="tag">LASTRO DESCENTRALIZADO</span>
          <h2>Certificado original conectado ao token</h2>
          <p>
            Quando publicado, cada lote ECOT recebe um hash criptográfico no Smart Contract,
            apontando para o certificado original preservado na rede IPFS.
          </p>
        </div>
        <div className="hash-card">
          <div className="hash-head"><span>IPFS / DOCUMENT HASH</span><b>DEMONSTRAÇÃO</b></div>
          <code>QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco</code>
          <div className="hash-meta">
            <span>Documento imutável</span>
            <span>SHA-256 verificável</span>
            <span>Referência on-chain</span>
          </div>
        </div>
      </section>

      <FootprintCalculator />

      <section className="flow">
        <div className="section-heading left">
          <span className="tag">DO ATIVO AO IMPACTO</span>
          <h2>Uma trilha clara para cada ECOT</h2>
        </div>
        <div className="cards">
          {[
            ["01", "Lastro", "Certificado, titularidade, registro e números de série do ativo ambiental."],
            ["02", "Registro", "SHA-256, documento em IPFS e referência do lote na blockchain Base."],
            ["03", "Tokenização", "Emissão limitada ao volume disponível: 1 ECOT representa 1 kg CO₂e."],
            ["04", "Neutralização", "Alocação, aposentadoria do crédito e certificado final para o cliente."],
          ].map((card) => (
            <article key={card[0]}>
              <b>{card[0]}</b>
              <h3>{card[1]}</h3>
              <p>{card[2]}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="split">
        <div>
          <span className="tag">PARA PESSOAS</span>
          <h2>Impacto mensal sem complicação</h2>
          <p>Escolha um valor fixo, acumule ECOT e acompanhe sua neutralização ao longo do tempo.</p>
          <a className="text-link" href="#planos">Conhecer planos →</a>
        </div>
        <div>
          <span className="tag">PARA EMPRESAS</span>
          <h2>Rewards que deixam prova</h2>
          <p>Recompense compras, indicações e ações sustentáveis com tokens ambientais rastreáveis.</p>
          <a className="text-link" href="#rewards">Conhecer EcoRewards →</a>
        </div>
      </section>
    </>
  );
}

function FootprintCalculator() {
  const [mode, setMode] = useState<CalculatorMode>("corporate");
  const [values, setValues] = useState<Record<CalculatorMode, FootprintInputs>>({
    corporate: { people: 15, flights: 5, vehicles: 3 },
    personal: { people: 1, flights: 2, vehicles: 1 },
  });

  const current = values[mode];
  const footprintKg = current.people * 400 + current.flights * 150 + current.vehicles * 2400;
  const footprintTons = footprintKg / 1000;

  function updateValue(key: keyof FootprintInputs, nextValue: number) {
    setValues((previous) => ({
      ...previous,
      [mode]: { ...previous[mode], [key]: Math.max(0, Math.floor(nextValue || 0)) },
    }));
  }

  function applyRecommendation() {
    localStorage.setItem("ecotracker_recommended_kg", String(footprintKg));
    location.hash = "marketplace";
  }

  return (
    <section className="calculator-section" id="calculator">
      <div className="calculator-copy">
        <span className="tag">ESTIME E NEUTRALIZE SUA PEGADA</span>
        <h2>Calcule suas emissões e defina a quantidade ideal de tokens.</h2>
        <p>
          Estimativa inicial simplificada para orientar a compra. Inventários corporativos oficiais
          devem considerar metodologia e dados específicos da operação.
        </p>
        <div className="calculator-tabs" role="tablist" aria-label="Tipo de pegada">
          <button className={mode === "corporate" ? "active" : ""} onClick={() => setMode("corporate")}>Pegada Corporativa</button>
          <button className={mode === "personal" ? "active" : ""} onClick={() => setMode("personal")}>Pegada Pessoal</button>
        </div>
      </div>

      <div className="calculator-card">
        <div className="calculator-title">
          <span>{mode === "corporate" ? "Estimativa de Emissões da Empresa" : "Estimativa de Emissões Pessoais"}</span>
          <b>ANUAL</b>
        </div>
        <Stepper
          label={mode === "corporate" ? "Funcionários" : "Pessoas no cálculo"}
          factor="400 kg CO₂/pessoa/ano"
          value={current.people}
          onChange={(value) => updateValue("people", value)}
        />
        <Stepper
          label="Voos"
          factor="150 kg CO₂ por voo"
          value={current.flights}
          onChange={(value) => updateValue("flights", value)}
        />
        <Stepper
          label="Veículos"
          factor="2.400 kg CO₂/veículo/ano"
          value={current.vehicles}
          onChange={(value) => updateValue("vehicles", value)}
        />
        <div className="footprint-result">
          <small>Pegada estimada</small>
          <strong>{footprintTons.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} tCO₂e</strong>
          <span>{footprintKg.toLocaleString("pt-BR")} kg CO₂e · recomendação de {footprintKg.toLocaleString("pt-BR")} ECOT</span>
        </div>
        <button className="recommendation-button" onClick={applyRecommendation}>Aplicar recomendação →</button>
      </div>
    </section>
  );
}

function Stepper({ label, factor, value, onChange }: { label: string; factor: string; value: number; onChange: (value: number) => void }) {
  return (
    <div className="stepper-row">
      <div>
        <b>{label}</b>
        <small>{factor}</small>
      </div>
      <div className="stepper-control">
        <button type="button" onClick={() => onChange(value - 1)} aria-label={`Diminuir ${label}`}>−</button>
        <input
          type="number"
          min="0"
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          aria-label={label}
        />
        <button type="button" onClick={() => onChange(value + 1)} aria-label={`Aumentar ${label}`}>+</button>
      </div>
    </div>
  );
}

function Marketplace() {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [message, setMessage] = useState("");

  useEffect(() => {
    api<Batch[]>("/batches").then(setBatches).catch((error) => setMessage(error.message));
  }, []);

  return (
    <section className="page">
      <div className="page-title">
        <span className="tag">MARKETPLACE PRIMÁRIO</span>
        <h1>Escolha a origem do seu impacto</h1>
        <p>Cada unidade permanece vinculada ao lote, projeto, vintage e registro ambiental.</p>
      </div>
      {message && <div className="notice">{message}</div>}
      <div className="project-grid">
        {batches.length === 0 ? (
          <div className="empty">Nenhum lote verificado disponível ainda.</div>
        ) : (
          batches.map((batch) => <ProjectCard key={batch.id} batch={batch} />)
        )}
      </div>
    </section>
  );
}

function ProjectCard({ batch }: { batch: Batch }) {
  const [open, setOpen] = useState(false);
  return (
    <article className="project-card">
      <div className="project-top">
        <span>{batch.registry}</span>
        <i className={batch.chain_status === "onchain" ? "on" : "off"}>{batch.chain_status}</i>
      </div>
      <h3>{batch.project_name}</h3>
      <p>{batch.location || "Brasil"} · Vintage {batch.vintage || "—"}</p>
      <div className="metrics">
        <div><small>Disponível</small><b>{num(batch.available_tokens)} kg</b></div>
        <div><small>Preço/kg</small><b>{money(batch.price_per_token)}</b></div>
      </div>
      <div className="registry">Registro: {batch.registry_id}</div>
      <button onClick={() => setOpen(!open)}>Comprar ECOT</button>
      {open && <Checkout batch={batch} />}
    </article>
  );
}

function Checkout({ batch }: { batch: Batch }) {
  const recommended = Math.max(1, Math.min(Number(localStorage.getItem("ecotracker_recommended_kg") || 100), batch.available_tokens));
  const [form, setForm] = useState({ buyerName: "", buyerEmail: "", tokenAmount: String(recommended) });
  const [message, setMessage] = useState("");
  const total = useMemo(
    () => Number(form.tokenAmount || 0) * Number(batch.price_per_token),
    [form.tokenAmount, batch.price_per_token],
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      const response = await api<{ public_code: string; total_price: string }>("/orders", {
        method: "POST",
        body: JSON.stringify({ ...form, batchId: batch.id, tokenAmount: Number(form.tokenAmount) }),
      });
      setMessage(`Pedido criado: ${response.public_code}. Total ${money(response.total_price)}.`);
    } catch (error) {
      setMessage((error as Error).message);
    }
  }

  return (
    <form className="inline-form" onSubmit={submit}>
      <input placeholder="Nome" value={form.buyerName} onChange={(event) => setForm({ ...form, buyerName: event.target.value })} />
      <input type="email" required placeholder="E-mail" value={form.buyerEmail} onChange={(event) => setForm({ ...form, buyerEmail: event.target.value })} />
      <input type="number" min="1" max={batch.available_tokens} required value={form.tokenAmount} onChange={(event) => setForm({ ...form, tokenAmount: event.target.value })} />
      <small>Total: {money(total)}</small>
      <button type="submit">Gerar pedido</button>
      {message && <div className="form-msg">{message}</div>}
    </form>
  );
}

function Plans() {
  const [form, setForm] = useState({ name: "", email: "", monthlyAmount: "49.90" });
  const [message, setMessage] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      await api("/subscriptions", {
        method: "POST",
        body: JSON.stringify({ ...form, monthlyAmount: Number(form.monthlyAmount) }),
      });
      setMessage("Solicitação recebida. O pagamento recorrente será ativado na próxima integração.");
    } catch (error) {
      setMessage((error as Error).message);
    }
  }

  return (
    <section className="page">
      <div className="page-title">
        <span className="tag">PLANO DE IMPACTO MENSAL</span>
        <h1>Um valor fixo. Impacto acumulado.</h1>
        <p>Escolha quanto destinar mensalmente e acompanhe seu volume ambiental.</p>
      </div>
      <div className="price-grid">
        {[["Essencial", "29,90", "Entrada simples"], ["Impacto", "59,90", "Mais volume e histórico"], ["Empresa", "299", "Relatório e selo"]].map((plan) => (
          <div className="price" key={plan[0]}>
            <span>{plan[0]}</span>
            <h2>R$ {plan[1]}<small>/mês</small></h2>
            <p>{plan[2]}</p>
          </div>
        ))}
      </div>
      <form className="lead-form" onSubmit={submit}>
        <h2>Manifestar interesse</h2>
        <input required placeholder="Nome" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
        <input required type="email" placeholder="E-mail" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
        <input required type="number" min="10" step="0.01" value={form.monthlyAmount} onChange={(event) => setForm({ ...form, monthlyAmount: event.target.value })} />
        <button>Quero meu plano</button>
        {message && <div className="form-msg">{message}</div>}
      </form>
    </section>
  );
}

function Rewards() {
  const [form, setForm] = useState({ companyName: "", contactName: "", email: "", monthlyCustomers: "", message: "" });
  const [message, setMessage] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      await api("/rewards/leads", {
        method: "POST",
        body: JSON.stringify({ ...form, monthlyCustomers: form.monthlyCustomers ? Number(form.monthlyCustomers) : undefined }),
      });
      setMessage("Contato recebido. Vamos estruturar a campanha piloto.");
    } catch (error) {
      setMessage((error as Error).message);
    }
  }

  return (
    <section className="page">
      <div className="page-title">
        <span className="tag">ECOTRACKER FOR BUSINESS</span>
        <h1>Recompensas com impacto rastreável</h1>
        <p>Distribua ECOT em compras, indicações, devolução de embalagens e campanhas especiais.</p>
      </div>
      <div className="cards rewards">
        {[["Compra", "1 ECOT a cada R$ 50"], ["Indicação", "20 ECOT por cliente indicado"], ["Ação verde", "10 ECOT por embalagem devolvida"]].map((reward) => (
          <article key={reward[0]}><h3>{reward[0]}</h3><p>{reward[1]}</p></article>
        ))}
      </div>
      <form className="lead-form" onSubmit={submit}>
        <h2>Criar campanha piloto</h2>
        <input required placeholder="Empresa" value={form.companyName} onChange={(event) => setForm({ ...form, companyName: event.target.value })} />
        <input required placeholder="Seu nome" value={form.contactName} onChange={(event) => setForm({ ...form, contactName: event.target.value })} />
        <input required type="email" placeholder="E-mail" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
        <input type="number" placeholder="Clientes por mês" value={form.monthlyCustomers} onChange={(event) => setForm({ ...form, monthlyCustomers: event.target.value })} />
        <textarea placeholder="Como imagina a campanha?" value={form.message} onChange={(event) => setForm({ ...form, message: event.target.value })} />
        <button>Solicitar demonstração</button>
        {message && <div className="form-msg">{message}</div>}
      </form>
    </section>
  );
}

function Admin() {
  const [token, setToken] = useState(localStorage.getItem("ecotracker_admin_token"));
  if (!token) {
    return <AdminLogin onLogin={(nextToken) => {
      localStorage.setItem("ecotracker_admin_token", nextToken);
      setToken(nextToken);
    }} />;
  }
  return <AdminPanel logout={() => {
    localStorage.removeItem("ecotracker_admin_token");
    setToken(null);
  }} />;
}

function AdminLogin({ onLogin }: { onLogin: (token: string) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      const response = await api<{ token: string }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      onLogin(response.token);
    } catch (error) {
      setMessage((error as Error).message);
    }
  }

  return (
    <section className="login">
      <form onSubmit={submit}>
        <div className="eyebrow">ÁREA INTERNA</div>
        <h1>Admin EcoTracker</h1>
        <input required type="email" placeholder="E-mail" value={email} onChange={(event) => setEmail(event.target.value)} />
        <input required type="password" placeholder="Senha" value={password} onChange={(event) => setPassword(event.target.value)} />
        <button>Entrar</button>
        {message && <div className="form-msg">{message}</div>}
      </form>
    </section>
  );
}

function AdminPanel({ logout }: { logout: () => void }) {
  const [tab, setTab] = useState("projects");
  const [projects, setProjects] = useState<Project[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [message, setMessage] = useState("");

  async function load() {
    try {
      const [projectData, batchData, orderData] = await Promise.all([
        api<Project[]>("/admin/projects"),
        api<Batch[]>("/admin/batches"),
        api<Order[]>("/admin/orders"),
      ]);
      setProjects(projectData);
      setBatches(batchData);
      setOrders(orderData);
    } catch (error) {
      setMessage((error as Error).message);
    }
  }

  useEffect(() => { load(); }, []);

  return (
    <section className="admin">
      <aside>
        <div className="brand"><span>eco</span>tracker</div>
        {[["projects", "Lastro"], ["batches", "Tokens ECOT"], ["orders", "Pedidos"]].map((item) => (
          <button className={tab === item[0] ? "active" : ""} onClick={() => setTab(item[0])} key={item[0]}>{item[1]}</button>
        ))}
        <button onClick={logout}>Sair</button>
      </aside>
      <div className="admin-main">
        <div className="admin-head">
          <h1>{tab === "projects" ? "Projetos e lastro" : tab === "batches" ? "Lotes ECOT" : "Pedidos"}</h1>
          <button className="small" onClick={load}>Atualizar</button>
        </div>
        {message && <div className="notice">{message}</div>}
        {tab === "projects" ? (
          <ProjectsAdmin projects={projects} reload={load} />
        ) : tab === "batches" ? (
          <BatchesAdmin projects={projects} batches={batches} reload={load} />
        ) : (
          <OrdersAdmin orders={orders} reload={load} />
        )}
      </div>
    </section>
  );
}

function ProjectsAdmin({ projects, reload }: { projects: Project[]; reload: () => void }) {
  const [message, setMessage] = useState("");

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await api("/admin/projects", { method: "POST", body: form });
      event.currentTarget.reset();
      setMessage("Projeto cadastrado para revisão.");
      reload();
    } catch (error) {
      setMessage((error as Error).message);
    }
  }

  async function verify(id: number) {
    const serialStart = prompt("Número de série inicial");
    if (!serialStart) return;
    const serialEnd = prompt("Número de série final (opcional)") || "";
    try {
      await api(`/admin/projects/${id}/verify`, {
        method: "POST",
        body: JSON.stringify({ serialStart, serialEnd }),
      });
      reload();
    } catch (error) {
      setMessage((error as Error).message);
    }
  }

  return (
    <>
      <form className="admin-form" onSubmit={create}>
        <h2>Novo projeto</h2>
        <input name="name" required placeholder="Nome do projeto" />
        <input name="registry" required placeholder="Registro (Verra, Gold Standard...)" />
        <input name="registryId" required placeholder="ID no registro" />
        <input name="totalKg" required type="number" min="1" placeholder="Volume total em kg" />
        <input name="vintage" placeholder="Vintage" />
        <input name="location" placeholder="Localização" />
        <input name="certificate" required type="file" accept="application/pdf,image/*" />
        <button>Cadastrar lastro</button>
        {message && <div className="form-msg">{message}</div>}
      </form>
      <div className="table">
        {projects.map((project) => (
          <div className="row" key={project.id}>
            <div><b>{project.name}</b><small>{project.registry} · {project.registry_id}</small></div>
            <span>{num(project.total_kg)} kg</span>
            <span className={`status ${project.verification_status}`}>{project.verification_status}</span>
            <button className="small" disabled={project.verification_status === "verified"} onClick={() => verify(project.id)}>Verificar</button>
          </div>
        ))}
      </div>
    </>
  );
}

function BatchesAdmin({ projects, batches, reload }: { projects: Project[]; batches: Batch[]; reload: () => void }) {
  const [message, setMessage] = useState("");

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await api("/admin/batches", {
        method: "POST",
        body: JSON.stringify({
          projectId: Number(form.get("projectId")),
          tokenAmount: Number(form.get("tokenAmount")),
          pricePerToken: Number(form.get("pricePerToken")),
        }),
      });
      event.currentTarget.reset();
      reload();
    } catch (error) {
      setMessage((error as Error).message);
    }
  }

  return (
    <>
      <form className="admin-form" onSubmit={create}>
        <h2>Emitir lote ECOT</h2>
        <select name="projectId" required>
          <option value="">Projeto verificado</option>
          {projects.filter((project) => project.verification_status === "verified").map((project) => (
            <option key={project.id} value={project.id}>{project.name}</option>
          ))}
        </select>
        <input name="tokenAmount" type="number" min="1" required placeholder="Quantidade ECOT" />
        <input name="pricePerToken" type="number" step="0.0001" min="0.0001" required placeholder="Preço por ECOT" />
        <button>Emitir lote</button>
        {message && <div className="form-msg">{message}</div>}
      </form>
      <div className="table">
        {batches.map((batch) => (
          <div className="row" key={batch.id}>
            <div><b>{batch.project_name}</b><small>Lote #{batch.id}</small></div>
            <span>{num(batch.available_tokens)} ECOT</span>
            <span>{money(batch.price_per_token)}</span>
            <span className={`status ${batch.chain_status}`}>{batch.chain_status}</span>
          </div>
        ))}
      </div>
    </>
  );
}

function OrdersAdmin({ orders, reload }: { orders: Order[]; reload: () => void }) {
  const [message, setMessage] = useState("");

  async function confirm(id: number) {
    try {
      await api(`/admin/orders/${id}/confirm`, { method: "POST" });
      reload();
    } catch (error) {
      setMessage((error as Error).message);
    }
  }

  return (
    <>
      {message && <div className="form-msg">{message}</div>}
      <div className="table">
        {orders.map((order) => (
          <div className="row" key={order.id}>
            <div><b>{order.buyer_name || order.buyer_email}</b><small>{order.project_name}</small></div>
            <span>{num(order.token_amount)} ECOT</span>
            <span>{money(order.total_price)}</span>
            <span className={`status ${order.payment_status}`}>{order.payment_status}</span>
            <button className="small" disabled={order.payment_status === "confirmed"} onClick={() => confirm(order.id)}>Confirmar</button>
          </div>
        ))}
      </div>
    </>
  );
}

function Footer() {
  return (
    <footer>
      <div className="footer-main">
        <div>
          <div className="brand"><span>eco</span>tracker</div>
          <p>Carbon Tokenization Protocol.</p>
          <small>ECOT é uma unidade ambiental vinculada ao lastro do lote, não um investimento.</small>
        </div>
        <div className="footer-contact" aria-label="Canais de contato">
          <a href="mailto:henriquecampos66@gmail.com" aria-label="Enviar e-mail" title="E-mail">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18v14H3V5Zm2 2v.5l7 5.1 7-5.1V7H5Zm14 10V9.9l-7 5.1-7-5.1V17h14Z" /></svg>
          </a>
          <a href="https://wa.me/5511947984328" target="_blank" rel="noreferrer" aria-label="Abrir WhatsApp" title="WhatsApp">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a9.7 9.7 0 0 0-8.3 14.7L2.4 22l5.5-1.3A9.8 9.8 0 1 0 12 2Zm0 17.6a7.7 7.7 0 0 1-3.9-1.1l-.4-.2-3.1.8.8-3-.2-.4A7.7 7.7 0 1 1 12 19.6Zm4.2-5.7c-.2-.1-1.4-.7-1.6-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1-1.5-.7-2.5-1.4-3.5-3.1-.3-.5.3-.5.8-1.6.1-.2 0-.4 0-.5l-.7-1.7c-.2-.5-.4-.4-.6-.4h-.5c-.2 0-.5.1-.7.3-.8.9-1.2 2-.9 3.2.4 1.8 1.6 3.5 3.3 4.8 1.6 1.2 3.9 2.2 5.4 1.7.9-.3 1.5-.9 1.7-1.5.2-.5.2-1 .1-1.1-.2-.2-.5-.3-.9-.5Z" /></svg>
          </a>
        </div>
      </div>
      <div className="footer-bottom">
        <span>Desenvolvido por <strong>Alternative Ventures Ltda</strong></span>
        <span>CNPJ 61.920.356/0001-38</span>
      </div>
    </footer>
  );
}
