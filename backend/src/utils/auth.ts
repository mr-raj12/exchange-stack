import jwt from "jsonwebtoken";
import type { JwtPayload as DefaultJwtPayload } from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET!;

if (!JWT_SECRET) {
    throw new Error("JWT_SECRET is not defined");
}

export interface AppJwtPayload {
    userId: string;
}

/**
 * Create JWT
 */
export function createToken(payload: AppJwtPayload): string {
    return jwt.sign(payload, JWT_SECRET, {
        algorithm: "HS256",
        expiresIn: "7d",
        issuer: "my-api",
        audience: "my-app",
    });
}

/**
 * Runtime payload validator
 */
function isValidPayload(payload: unknown): payload is AppJwtPayload {
    return (
        typeof payload === "object" &&
        payload !== null &&
        "userId" in payload &&
        typeof (payload as Record<string, unknown>).userId === "string"
    );
}

/**
 * Verify JWT safely
 */
export function verifyToken(token: string): AppJwtPayload {
    let decoded: string | DefaultJwtPayload;

    try {
        decoded = jwt.verify(token, JWT_SECRET, {
            algorithms: ["HS256"],
            issuer: "my-api",
            audience: "my-app",
        });
    } catch {
        throw new Error("Invalid or expired token");
    }

    if (!isValidPayload(decoded)) {
        throw new Error("Invalid token payload");
    }

    return decoded;
}