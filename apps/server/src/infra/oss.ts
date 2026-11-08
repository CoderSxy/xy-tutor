import OSS from 'ali-oss';
import {randomUUID} from 'node:crypto';
export type ObjectMetadata={size:number;contentType:string;prefix:Buffer};
export interface FileStore {signUpload(input:{key:string;contentType:string}):Promise<{url:string;headers:Record<string,string>}>;head(key:string):Promise<ObjectMetadata>;signDownload(key:string,ttlSeconds:number):Promise<string>;read(key:string):Promise<Buffer>;seal(key:string):Promise<string>;}
export function createFileStore(env:Record<string,string|undefined>):FileStore|undefined{if(!env.OSS_BUCKET||!env.OSS_REGION||!env.OSS_ACCESS_KEY_ID||!env.OSS_ACCESS_KEY_SECRET)return undefined;return new OssFileStore(new OSS({region:env.OSS_REGION,bucket:env.OSS_BUCKET,accessKeyId:env.OSS_ACCESS_KEY_ID,accessKeySecret:env.OSS_ACCESS_KEY_SECRET,secure:true}));}
export class OssFileStore implements FileStore {
 constructor(private client:OSS){}
 async signUpload(input:{key:string;contentType:string}){return {url:this.client.signatureUrl(input.key,{method:'PUT',expires:300,'Content-Type':input.contentType}),headers:{'Content-Type':input.contentType}};}
 async head(key:string){const h=await this.client.head(key);const first=await this.client.get(key,{headers:{Range:'bytes=0-65535'}});const headers=h.res.headers as Record<string,string>;return {size:Number(headers['content-length']),contentType:String(headers['content-type']),prefix:Buffer.from(first.content)};}
 async signDownload(key:string,ttlSeconds:number){return this.client.signatureUrl(key,{expires:ttlSeconds});}
 async seal(key:string){const sealed=`sealed/${randomUUID()}`;await this.client.copy(sealed,key);return sealed;}
 async read(key:string){const object=await this.client.get(key);return Buffer.from(object.content);}
}
