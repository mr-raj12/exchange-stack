import jwt from "jsonwebtoken";

const JWT_SECRET=process.env.JWT_SECRET!;

export interface JwtPayload {
    userId: string;
    // string is a primitive type and String is a wrapper object
}

export function createToken(payload: JwtPayload): string {
    return jwt.sign(payload,JWT_SECRET, {expiresIn:"7d"});
}

export function verifyToken(token: string): JwtPayload {
    return jwt.verify(token, JWT_SECRET) as JwtPayload;
}