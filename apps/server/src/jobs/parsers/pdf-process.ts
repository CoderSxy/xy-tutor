import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {imageSize} from 'image-size';
import {z} from 'zod';
import type {OcrProvider} from './ocr.js';
export type ParsedPage={pdfPageIndex:number;printedPageLabel?:string;text:string;status:'ready'|'needs_ocr'|'failed';imageBase64?:string};
const pageSchema=z.object({pdfPageIndex:z.number().int().nonnegative(),printedPageLabel:z.string().optional(),text:z.string().max(200000),status:z.enum(['ready','needs_ocr','failed']),imageBase64:z.string().max(10000000).optional()});
export async function* parseDocument(input:{bytes:Buffer;contentType:string;signal:AbortSignal;ocr?:OcrProvider}):AsyncGenerator<ParsedPage>{
 input.signal.throwIfAborted();if(input.bytes.length>30*1024*1024)throw Error('FILE_SIZE_LIMIT');
 if(input.contentType!=='application/pdf'){const dimensions=imageSize(input.bytes);if(!dimensions.width||!dimensions.height||dimensions.width*dimensions.height>20000000)throw Error('IMAGE_PIXEL_LIMIT');const recognized=input.ocr?await input.ocr.recognize(input,input.signal):undefined;yield {pdfPageIndex:0,text:recognized?.text??'',status:recognized?'ready':'needs_ocr'};return;}
 const dir=await mkdtemp(join(tmpdir(),'xy-tutor-parse-'));const path=join(dir,'document.pdf');await writeFile(path,input.bytes,{mode:0o600});
 const compiled=fileURLToPath(new URL('./pdf-child.js',import.meta.url));const source=fileURLToPath(new URL('./pdf-child.ts',import.meta.url));const script=existsSync(compiled)?compiled:source;
 const args=['--max-old-space-size=256',...(script.endsWith('.ts')?['--import','tsx']:[]),script,path,input.ocr?'render':'text'];
 const child=spawn(process.execPath,args,{stdio:['ignore','pipe','pipe'],signal:input.signal});child.stderr.resume();let failure:Error|undefined;
 const exited=new Promise<void>(resolve=>{child.once('error',error=>{failure=error;resolve();});child.once('close',code=>{if(code!==0)failure??=Error('PDF_PARSE_FAILED');resolve();});});
 let timer=setTimeout(()=>child.kill('SIGKILL'),30000);
 try{for await(const line of createInterface({input:child.stdout})){if(line.length>11000000)throw Error('PARSE_OUTPUT_LIMIT');let value:unknown;try{value=JSON.parse(line);}catch{continue;}
   if(value&&typeof value==='object'&&'error' in value)throw Error(String(value.error));const result=pageSchema.safeParse(value);if(!result.success)continue;clearTimeout(timer);timer=setTimeout(()=>child.kill('SIGKILL'),30000);const page=result.data;
   if(page.imageBase64&&input.ocr){const recognized=await input.ocr.recognize({bytes:Buffer.from(page.imageBase64,'base64'),contentType:'image/png'},input.signal);page.text=recognized.text;page.status='ready';}
   delete page.imageBase64;yield page;
  }await exited;if(failure)throw failure;
 }finally{clearTimeout(timer);if(child.exitCode===null)child.kill('SIGKILL');await exited;await rm(dir,{recursive:true,force:true});}
}
