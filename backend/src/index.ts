import "dotenv/config";
import crypto from "node:crypto";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import multer from "multer";
import { z } from "zod";
import { createAdminToken, requireAdmin } from "./auth.js";
import { registerAssetOnChain, registerBatchOnChain } from "./blockchain.js";
import { initDb, pool, withTransaction } from "./db.js";
import { uploadToPinata } from "./ipfs.js";

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const port = Number(process.env.PORT || 4000);

app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL ? process.env.FRONTEND_URL.split(",") : true }));
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => res.json({ status: "ok", service: "ecotracker-api" }));

app.post("/api/auth/login", (req, res) => {
  const parsed = z.object({ email: z.string().email(), password: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos" });
  if (parsed.data.email !== process.env.ADMIN_EMAIL || parsed.data.password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Credenciais inválidas" });
  }
  return res.json({ token: createAdminToken() });
});

app.get("/api/projects", async (_req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT p.*, COALESCE(SUM(CASE WHEN b.status='active' THEN b.available_tokens ELSE 0 END),0) AS available_tokens,
             MIN(CASE WHEN b.status='active' THEN b.price_per_token END) AS price_per_token
      FROM carbon_projects p
      LEFT JOIN ecot_batches b ON b.project_id=p.id
      WHERE p.verification_status='verified'
      GROUP BY p.id ORDER BY p.created_at DESC
    `);
    res.json(rows);
  } catch (error) { next(error); }
});

app.get("/api/batches", async (_req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT b.*, p.name AS project_name, p.registry, p.registry_id, p.vintage, p.location, p.ipfs_cid
      FROM ecot_batches b JOIN carbon_projects p ON p.id=b.project_id
      WHERE b.status='active' AND b.available_tokens>0 AND p.verification_status='verified'
      ORDER BY b.created_at DESC
    `);
    res.json(rows);
  } catch (error) { next(error); }
});

app.post("/api/orders", async (req, res, next) => {
  const parsed = z.object({
    batchId: z.coerce.number().int().positive(), buyerName: z.string().max(255).optional(),
    buyerEmail: z.string().email(), tokenAmount: z.coerce.number().int().positive(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Pedido inválido" });
  try {
    const { rows } = await pool.query("SELECT * FROM ecot_batches WHERE id=$1 AND status='active'", [parsed.data.batchId]);
    const batch = rows[0];
    if (!batch || Number(batch.available_tokens) < parsed.data.tokenAmount) return res.status(409).json({ error: "Estoque insuficiente" });
    const total = (Number(batch.price_per_token) * parsed.data.tokenAmount).toFixed(2);
    const result = await pool.query(`INSERT INTO orders(batch_id,buyer_name,buyer_email,token_amount,total_price)
      VALUES($1,$2,$3,$4,$5) RETURNING id,public_code,total_price,payment_status`,
      [parsed.data.batchId, parsed.data.buyerName ?? null, parsed.data.buyerEmail, parsed.data.tokenAmount, total]);
    res.status(201).json(result.rows[0]);
  } catch (error) { next(error); }
});

app.post("/api/subscriptions", async (req, res, next) => {
  const parsed = z.object({ name: z.string().min(2), email: z.string().email(), monthlyAmount: z.coerce.number().positive() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos" });
  try {
    const { rows } = await pool.query("INSERT INTO subscription_requests(name,email,monthly_amount) VALUES($1,$2,$3) RETURNING id,status", [parsed.data.name, parsed.data.email, parsed.data.monthlyAmount]);
    res.status(201).json(rows[0]);
  } catch (error) { next(error); }
});

app.post("/api/rewards/leads", async (req, res, next) => {
  const parsed = z.object({ companyName: z.string().min(2), contactName: z.string().min(2), email: z.string().email(), monthlyCustomers: z.coerce.number().int().nonnegative().optional(), message: z.string().max(3000).optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos" });
  try {
    const { rows } = await pool.query("INSERT INTO reward_leads(company_name,contact_name,email,monthly_customers,message) VALUES($1,$2,$3,$4,$5) RETURNING id,status", [parsed.data.companyName, parsed.data.contactName, parsed.data.email, parsed.data.monthlyCustomers ?? null, parsed.data.message ?? null]);
    res.status(201).json(rows[0]);
  } catch (error) { next(error); }
});

app.get("/api/admin/projects", requireAdmin, async (_req, res, next) => {
  try { const { rows } = await pool.query("SELECT * FROM carbon_projects ORDER BY created_at DESC"); res.json(rows); } catch (error) { next(error); }
});

app.post("/api/admin/projects", requireAdmin, upload.single("certificate"), async (req, res, next) => {
  const parsed = z.object({ name:z.string().min(3), description:z.string().optional(), registry:z.string().min(2), registryId:z.string().min(2), methodology:z.string().optional(), developer:z.string().optional(), vintage:z.string().optional(), location:z.string().optional(), totalKg:z.coerce.number().int().positive() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Projeto inválido", details: parsed.error.flatten() });
  try {
    const file = req.file;
    const sha = file ? crypto.createHash("sha256").update(file.buffer).digest("hex") : null;
    const cid = file ? await uploadToPinata(file) : null;
    const { rows } = await pool.query(`INSERT INTO carbon_projects(name,description,registry,registry_id,methodology,developer,vintage,location,total_kg,certificate_filename,certificate_mime,certificate_sha256,ipfs_cid)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [parsed.data.name, parsed.data.description??null, parsed.data.registry, parsed.data.registryId, parsed.data.methodology??null, parsed.data.developer??null, parsed.data.vintage??null, parsed.data.location??null, parsed.data.totalKg, file?.originalname??null, file?.mimetype??null, sha, cid]);
    res.status(201).json(rows[0]);
  } catch (error) { next(error); }
});

app.post("/api/admin/projects/:id/verify", requireAdmin, async (req, res, next) => {
  const parsed = z.object({ serialStart:z.string().min(1), serialEnd:z.string().optional(), notes:z.string().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados de verificação inválidos" });
  try {
    const projectId = Number(req.params.id);
    const projectResult = await pool.query("SELECT * FROM carbon_projects WHERE id=$1", [projectId]);
    const project = projectResult.rows[0];
    if (!project) return res.status(404).json({ error: "Projeto não encontrado" });
    if (!project.certificate_sha256) return res.status(409).json({ error: "Certificado e SHA-256 são obrigatórios" });
    const registryKey = `${project.registry}:${project.registry_id}`;
    await withTransaction(async client => {
      await client.query("INSERT INTO asset_serial_ranges(project_id,registry_key,serial_start,serial_end) VALUES($1,$2,$3,$4)", [projectId, registryKey, parsed.data.serialStart, parsed.data.serialEnd ?? ""]);
      await client.query("UPDATE carbon_projects SET verification_status='verified',verification_notes=$2,verified_at=NOW() WHERE id=$1", [projectId, parsed.data.notes ?? null]);
    });
    let chainTxHash: string | null = null;
    try { chainTxHash = await registerAssetOnChain({ registry:project.registry, registryId:project.registry_id, documentSha256:project.certificate_sha256, totalKg:Number(project.total_kg) }); } catch (e) { console.error("[blockchain] asset registration failed", e); }
    if (chainTxHash) await pool.query("UPDATE carbon_projects SET chain_tx_hash=$2 WHERE id=$1", [projectId, chainTxHash]);
    res.json({ success:true, chainTxHash, chainStatus:chainTxHash?"onchain":"offchain" });
  } catch (error) { next(error); }
});

app.get("/api/admin/batches", requireAdmin, async (_req, res, next) => {
  try { const { rows } = await pool.query("SELECT b.*,p.name AS project_name FROM ecot_batches b JOIN carbon_projects p ON p.id=b.project_id ORDER BY b.created_at DESC"); res.json(rows); } catch (error) { next(error); }
});

app.post("/api/admin/batches", requireAdmin, async (req, res, next) => {
  const parsed = z.object({ projectId:z.coerce.number().int().positive(), tokenAmount:z.coerce.number().int().positive(), pricePerToken:z.coerce.number().positive() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Lote inválido" });
  try {
    const batch = await withTransaction(async client => {
      const result = await client.query("SELECT * FROM carbon_projects WHERE id=$1 FOR UPDATE", [parsed.data.projectId]);
      const project = result.rows[0];
      if (!project) throw Object.assign(new Error("Projeto não encontrado"), { status:404 });
      if (project.verification_status !== "verified") throw Object.assign(new Error("Projeto ainda não foi verificado"), { status:409 });
      const remaining = Number(project.total_kg)-Number(project.tokenized_kg)-Number(project.retired_kg);
      if (parsed.data.tokenAmount > remaining) throw Object.assign(new Error(`Lastro insuficiente. Disponível: ${remaining} kg`), { status:409 });
      const inserted = await client.query("INSERT INTO ecot_batches(project_id,total_tokens,available_tokens,price_per_token) VALUES($1,$2,$2,$3) RETURNING *", [parsed.data.projectId, parsed.data.tokenAmount, parsed.data.pricePerToken]);
      await client.query("UPDATE carbon_projects SET tokenized_kg=tokenized_kg+$2 WHERE id=$1", [parsed.data.projectId, parsed.data.tokenAmount]);
      return { ...inserted.rows[0], project };
    });
    let chainTxHash: string | null = null;
    try { chainTxHash = await registerBatchOnChain({ registry:batch.project.registry, registryId:batch.project.registry_id, batchId:Number(batch.id), tokenAmount:parsed.data.tokenAmount }); } catch (e) { console.error("[blockchain] batch registration failed", e); }
    if (chainTxHash) await pool.query("UPDATE ecot_batches SET chain_status='onchain',chain_tx_hash=$2 WHERE id=$1", [batch.id, chainTxHash]);
    res.status(201).json({ ...batch, chainTxHash, chainStatus:chainTxHash?"onchain":"offchain" });
  } catch (error) { next(error); }
});

app.get("/api/admin/orders", requireAdmin, async (_req, res, next) => {
  try { const { rows } = await pool.query("SELECT o.*,p.name AS project_name FROM orders o JOIN ecot_batches b ON b.id=o.batch_id JOIN carbon_projects p ON p.id=b.project_id ORDER BY o.created_at DESC"); res.json(rows); } catch (error) { next(error); }
});

app.post("/api/admin/orders/:id/confirm", requireAdmin, async (req, res, next) => {
  try {
    const orderId = Number(req.params.id);
    const order = await withTransaction(async client => {
      const orderResult = await client.query("SELECT * FROM orders WHERE id=$1 FOR UPDATE", [orderId]);
      const current = orderResult.rows[0];
      if (!current) throw Object.assign(new Error("Pedido não encontrado"), { status:404 });
      if (current.payment_status === "confirmed") return current;
      const batchResult = await client.query("SELECT * FROM ecot_batches WHERE id=$1 FOR UPDATE", [current.batch_id]);
      const batch = batchResult.rows[0];
      if (!batch || Number(batch.available_tokens) < Number(current.token_amount)) throw Object.assign(new Error("Estoque insuficiente"), { status:409 });
      await client.query("UPDATE ecot_batches SET available_tokens=available_tokens-$2,status=CASE WHEN available_tokens-$2=0 THEN 'sold_out' ELSE status END WHERE id=$1", [current.batch_id, current.token_amount]);
      const updated = await client.query("UPDATE orders SET payment_status='confirmed',delivery_status='delivered',confirmed_at=NOW() WHERE id=$1 RETURNING *", [orderId]);
      return updated.rows[0];
    });
    res.json(order);
  } catch (error) { next(error); }
});

app.post("/api/admin/distributions", requireAdmin, async (req, res, next) => {
  const parsed = z.object({ batchId:z.coerce.number().int().positive(), recipientName:z.string().optional(), recipientEmail:z.string().email(), tokenAmount:z.coerce.number().int().positive(), organizationName:z.string().optional(), source:z.enum(["manual","reward"]).default("manual") }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Distribuição inválida" });
  try {
    const distribution = await withTransaction(async client => {
      const batchResult = await client.query("SELECT * FROM ecot_batches WHERE id=$1 FOR UPDATE", [parsed.data.batchId]);
      const batch = batchResult.rows[0];
      if (!batch || batch.status !== 'active' || Number(batch.available_tokens) < parsed.data.tokenAmount) throw Object.assign(new Error("Estoque insuficiente"), { status:409 });
      await client.query("UPDATE ecot_batches SET available_tokens=available_tokens-$2,status=CASE WHEN available_tokens-$2=0 THEN 'sold_out' ELSE status END WHERE id=$1", [parsed.data.batchId, parsed.data.tokenAmount]);
      const result = await client.query("INSERT INTO distributions(batch_id,recipient_name,recipient_email,token_amount,organization_name,source) VALUES($1,$2,$3,$4,$5,$6) RETURNING *", [parsed.data.batchId, parsed.data.recipientName??null, parsed.data.recipientEmail, parsed.data.tokenAmount, parsed.data.organizationName??null, parsed.data.source]);
      return result.rows[0];
    });
    res.status(201).json(distribution);
  } catch (error) { next(error); }
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(error);
  const status = typeof error === "object" && error && "status" in error ? Number((error as {status:number}).status) : 500;
  const message = error instanceof Error ? error.message : "Erro interno";
  res.status(status).json({ error: message });
});

await initDb();
app.listen(port, "0.0.0.0", () => console.log(`[ecotracker] API on :${port}`));
