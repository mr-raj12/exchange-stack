import { z } from "zod";

export const authSchema = z.object({
    username: z.string().min(3).max(32),
    password: z.string().min(6),
});

export type AuthBody = z.infer<typeof authSchema>; // ts looks schema and infers magic type, depends only on the schema -- one source of truth