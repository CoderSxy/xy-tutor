import {randomUUID} from 'node:crypto';
import {createFileStore} from '../apps/server/src/infra/oss.js';
const store=createFileStore(process.env);if(!store){console.error('UNVERIFIED: configure OSS_REGION, OSS_BUCKET and OSS credentials; see docs/runbooks/external-services.md');process.exitCode=1;}else{
 const key=`smoke/${randomUUID()}.pdf`;const bytes=Buffer.from('%PDF-1.7\n% connection probe\n');const grant=await store.signUpload({key,contentType:'application/pdf'});const response=await fetch(grant.url,{method:'PUT',headers:grant.headers,body:bytes});if(!response.ok)throw Error('OSS probe upload failed');const metadata=await store.head(key);if(metadata.size!==bytes.length)throw Error('OSS size mismatch');const download=await fetch(await store.signDownload(key,60));if(!download.ok)throw Error('OSS probe download failed');console.log('OSS upload and authorized download verified. Remove smoke objects using your bucket lifecycle policy.');
}
