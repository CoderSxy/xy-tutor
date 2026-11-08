import {z} from 'zod';
export const loginName=z.string().trim().min(2).max(80).transform(s=>s.toLowerCase());
export const password=z.string().min(10).max(128);
export const inviteInput=z.object({login:loginName,role:z.enum(['student','admin']).default('student')}).strict();
export const credentialInput=z.object({token:z.string().min(32).max(200),password}).strict();
export const loginInput=z.object({login:loginName,password:z.string().min(1).max(128)}).strict();
export const profileInput=z.object({displayName:z.string().trim().min(1).max(80).optional(),preferences:z.record(z.string(),z.string().max(500)).optional()}).strict();
