export type CitedChunk={id:string;revisionId:string;chapterId:string;pdfPageIndex:number;printedPageLabel:string|null;text:string};
export const citedChunkSelect=`SELECT c.id,c.revision_id AS "revisionId",c.chapter_id AS "chapterId",p.page_index AS "pdfPageIndex",p.printed_page_label AS "printedPageLabel",c.text FROM textbook_chunks c JOIN textbook_pages p ON p.id=c.page_id`;
