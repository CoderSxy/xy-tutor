import {readFile} from 'node:fs/promises';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {createCanvas} from '@napi-rs/canvas';
const path=process.argv[2];if(!path)throw Error('Missing private input');
try{
 const loadingTask=getDocument({data:new Uint8Array(await readFile(path)),useSystemFonts:true});
 const doc=await loadingTask.promise;
 if(doc.numPages>100)throw Error('PDF_PAGE_LIMIT');const labels=await doc.getPageLabels();
 for(let i=1;i<=doc.numPages;i++){
  const page=await doc.getPage(i);const content=await page.getTextContent();const text=content.items.map(item=>'str' in item?item.str:'').join(' ').trim();
  let imageBase64:string|undefined;if(!text&&process.argv[3]==='render'){
   const original=page.getViewport({scale:1});if(original.width*original.height>20000000)throw Error('IMAGE_PIXEL_LIMIT');
   const viewport=page.getViewport({scale:Math.min(2,1600/Math.max(original.width,original.height))});const canvas=createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height));
   await page.render({canvas:canvas as unknown as HTMLCanvasElement,canvasContext:canvas.getContext('2d') as unknown as CanvasRenderingContext2D,viewport}).promise;imageBase64=canvas.toBuffer('image/png').toString('base64');
  }
  process.stdout.write(JSON.stringify({pdfPageIndex:i-1,printedPageLabel:labels?.[i-1],text,status:text?'ready':'needs_ocr',imageBase64})+'\n');page.cleanup();
 }
 await loadingTask.destroy();
}catch(error){if(process.env.DEBUG_PARSER)console.error(error);process.stdout.write(JSON.stringify({error:error instanceof Error&&error.message==='PDF_PAGE_LIMIT'?'PDF_PAGE_LIMIT':'PDF_PARSE_FAILED'})+'\n');process.exitCode=1;}
