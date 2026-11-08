import {z} from 'zod';
export const uploadInput=z.object({studentId:z.uuid().optional(),purpose:z.enum(['textbook','student_material']),name:z.string().min(1).max(200),contentType:z.enum(['application/pdf','image/jpeg','image/png','image/webp']),size:z.number().int().positive()}).strict();
export type UploadGrant={fileId:string;key:string;url:string;headers:Record<string,string>;expiresAt:string};
