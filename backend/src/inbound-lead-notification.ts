type LeadNotification = {
  protocol: string;
  companyName: string;
  contactName: string;
  email: string;
  phone?: string;
  targetTonnes: number;
  claimPurpose: string;
  preferredRegistry?: string;
  preferredCountry?: string;
  preferredProjectType?: string;
  desiredBy?: string;
  opportunityId: number;
};

function esc(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function tonnes(value: number) {
  return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 3 }).format(value);
}

export async function notifyInboundCorporateLead(input: LeadNotification) {
  const apiKey = String(process.env.RESEND_API_KEY || "").trim();
  const from = String(process.env.EMAIL_FROM || "").trim();
  const to = String(process.env.ECOT_LEAD_NOTIFY_EMAIL || process.env.ECOT_LEGAL_EMAIL || process.env.ADMIN_EMAIL || "").trim();
  if (!apiKey || !from || !to) return { sent: false, reason: "notification_not_configured" };

  const appUrl = String(process.env.PUBLIC_APP_URL || "https://ecotracker10.netlify.app").replace(/\/$/, "");
  const purpose = input.claimPurpose === "voluntary_offset" ? "Compensação voluntária" : "Contribuição climática";
  const subject = "🔥 Novo lead EcoTracker · " + input.companyName + " · " + tonnes(input.targetTonnes) + " tCO₂e";
  const details = [
    "Empresa: " + input.companyName,
    "Responsável: " + input.contactName,
    "E-mail: " + input.email,
    "Telefone: " + (input.phone || "não informado"),
    "Volume: " + tonnes(input.targetTonnes) + " tCO₂e",
    "Finalidade: " + purpose,
    "Registry preferido: " + (input.preferredRegistry || "sem preferência"),
    "País/região: " + (input.preferredCountry || "sem preferência"),
    "Tipo de projeto: " + (input.preferredProjectType || "sem preferência"),
    "Prazo desejado: " + (input.desiredBy || "não informado"),
    "Protocolo: " + input.protocol,
    "Opportunity ID: " + input.opportunityId,
  ];
  const text = "Novo pedido corporativo recebido no EcoTracker.\n\n" + details.join("\n") + "\n\nAbrir Vender: " + appUrl + "/#sell";
  const rows = details.map((line) => {
    const parts = line.split(":");
    const label = parts.shift() || "";
    return "<tr><td style=\"padding:5px 14px 5px 0;color:#64748b\">" + esc(label) + "</td><td style=\"padding:5px 0\"><strong>" + esc(parts.join(":").trim()) + "</strong></td></tr>";
  }).join("");
  const html = "<h2>Novo pedido corporativo EcoTracker</h2>" +
    "<p><strong>" + esc(input.companyName) + "</strong> solicitou <strong>" + esc(tonnes(input.targetTonnes)) + " tCO₂e</strong>.</p>" +
    "<table style=\"border-collapse:collapse\">" + rows + "</table>" +
    "<p><a href=\"" + esc(appUrl) + "/#sell\">Abrir Sell Desk EcoTracker</a></p>";

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + apiKey,
      "Content-Type": "application/json",
      "Idempotency-Key": "ecotracker-inbound-lead/" + input.protocol,
    },
    body: JSON.stringify({ from, to: [to], subject, text, html }),
  });
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error("Resend " + response.status + ": " + String(data.message || "falha no alerta de lead"));
  return { sent: true, providerReference: String(data.id || "") || null };
}
