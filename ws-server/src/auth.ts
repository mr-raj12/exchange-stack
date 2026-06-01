import jwt from "jsonwebtoken";
import type { JwtPayload as DefaultJwtPayload } from "jsonwebtoken";

export interface AppJwtPayload {
  userId: string;
}

function isValidPayload(payload: unknown): payload is AppJwtPayload {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "userId" in payload &&
    typeof (payload as Record<string, unknown>).userId === "string"
  );
}

export function verifyToken(token: string): AppJwtPayload {
  const secret = process.env.JWT_SECRET!;
  let decoded: string | DefaultJwtPayload;
  try {
    decoded = jwt.verify(token, secret, {
      algorithms: ["HS256"],
      issuer: "my-api",
      audience: "my-app",
    });
  } catch {
    throw new Error("Invalid or expired token");
  }
  if (!isValidPayload(decoded)) throw new Error("Invalid token payload");
  return decoded;
}
