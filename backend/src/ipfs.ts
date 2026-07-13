export async function uploadToPinata(file: Express.Multer.File): Promise<string | null> {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) return null;

  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(file.buffer)], { type: file.mimetype }), file.originalname);
  form.append("pinataMetadata", JSON.stringify({ name: `ecotracker-${Date.now()}-${file.originalname}` }));

  const response = await fetch("https://uploads.pinata.cloud/v3/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
    body: form,
  });
  if (!response.ok) throw new Error(`Falha no IPFS: ${response.status}`);
  const data = (await response.json()) as { data?: { cid?: string } };
  return data.data?.cid ?? null;
}
