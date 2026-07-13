import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";

const secret = process.env.JWT_SECRET || "development-secret";

export function createAdminToken(): string {
  return jwt.sign({ role: "admin" }, secret, { expiresIn: "12h" });
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: "Não autenticado" });
    return;
  }
  try {
    const payload = jwt.verify(token, secret) as { role?: string };
    if (payload.role !== "admin") throw new Error("forbidden");
    next();
  } catch {
    res.status(403).json({ error: "Sessão inválida ou expirada" });
  }
}
