import { execFileSync } from "node:child_process";
import fs from "node:fs";

const protectedKeys = [
  "WOOVI_APP_ID",
  "WOOVI_API_KEY",
  "WOOVI_WEBHOOK_SECRET",
  "MP_ACCESS_TOKEN",
  "RESEND_API_KEY",
  "CARBONMARK_API_KEY",
  "PURO_REGISTRY_BASIC_AUTH",
  "PINATA_JWT",
  "BLOCKCHAIN_PRIVATE_KEY",
  "SOURCE_EXECUTOR_TOKEN",
  "RETIREMENT_EXECUTOR_TOKEN",
  "DELIVERY_EXECUTOR_TOKEN",
  "NFSE_PROVIDER_TOKEN",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "PLUGGY_CLIENT_SECRET",
  "KLAVI_SECRET_KEY",
  "KLAVI_ACCESS_KEY",
  "EFI_CLIENT_SECRET",
  "EFI_CERTIFICATE_BASE64",
];

const textExtensions = new Set([
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".json", ".yml", ".yaml", ".md", ".txt", ".env", ".example", ".toml", ".ini", ".sh",
]);

function isTextFile(file) {
  if (file === "render.yaml" || file.endsWith(".env.example")) return true;
  const dot = file.lastIndexOf(".");
  return dot >= 0 && textExtensions.has(file.slice(dot));
}

function normalize(raw) {
  return raw
    .trim()
    .replace(/^["'`]/, "")
    .replace(/["'`,;]+$/, "")
    .trim();
}

function isSafePlaceholder(value) {
  if (!value) return true;
  if (value.startsWith("${{")) return true;
  if (value.startsWith("process.env.")) return true;
  if (value.startsWith("Deno.env.")) return true;
  if (value.startsWith("<") && value.endsWith(">")) return true;
  if (/^(?:false|true|disabled|null|undefined)$/i.test(value)) return true;
  if (/change[-_ ]?me/i.test(value)) return true;
  if (/(?:xxxxx|your[-_ ]?|seu[-_ ]?|sua[-_ ]?|aqui|generate|example|placeholder)/i.test(value)) return true;
  return false;
}

const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split(/\r?\n/)
  .filter(Boolean)
  .filter((file) => !file.startsWith("node_modules/") && !file.includes("/node_modules/"))
  .filter(isTextFile);

const findings = [];
for (const file of files) {
  let stat;
  try { stat = fs.statSync(file); } catch { continue; }
  if (!stat.isFile() || stat.size > 2_000_000) continue;
  const content = fs.readFileSync(file, "utf8");
  const lines = content.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const key of protectedKeys) {
      const match = line.match(new RegExp(`(?:^|[\\s,{])${key}\\s*[:=]\\s*(.*)$`));
      if (!match) continue;
      const value = normalize(match[1].split(/\s+#/)[0]);
      if (isSafePlaceholder(value)) continue;
      findings.push({ file, line: index + 1, key });
    }
  });
}

if (findings.length) {
  console.error("Secret guard bloqueou possíveis credenciais hardcoded:");
  for (const finding of findings) console.error(`- ${finding.file}:${finding.line} · ${finding.key}`);
  console.error("Remova o valor do repositório e use variável de ambiente / GitHub Secret. O valor detectado não é impresso por segurança.");
  process.exit(1);
}

console.log(`Secret guard OK · ${files.length} arquivos textuais verificados · ${protectedKeys.length} chaves protegidas.`);
