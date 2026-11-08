import {z} from 'zod';
import type {StudentScope} from '../../../../../packages/contracts/src/domain.js';
import {AppError} from '../../../../../packages/contracts/src/api.js';
import type {CatalogService} from './service.js';
import {citedChunkSelect,type CitedChunk} from './citations.js';
export type TextbookScope={student:StudentScope;revisionId:string};
const querySchema=z.object({chapterId:z.uuid().optional(),keywords:z.string().max(255),limit:z.number().int().min(1).max(10)});
function keywords(text:string):string[]{const terms=text.normalize('NFKC').toLowerCase().match(/[\p{Script=Han}]{2,}|[\p{L}\p{N}]+/gu)??[];const tokens=new Set<string>();for(const term of terms){tokens.add(term);if(/^[\p{Script=Han}]+$/u.test(term))for(let i=0;i<term.length-1;i++)tokens.add(term.slice(i,i+2));}return [...tokens].slice(0,20).map(t=>`%${t}%`);}
export class TextbookSearch {
 constructor(private catalog:CatalogService){}
 private async authorize(scope:TextbookScope){await this.catalog.auth.requireStudentAccess(scope.student.actor,scope.student.studentId);z.uuid().parse(scope.revisionId);if(!await this.catalog.canReadRevision(scope.student.actor,scope.revisionId))throw new AppError('NOT_FOUND',404,'教材不可用于当前学习');}
 async searchTextbook(scope:TextbookScope,input:{chapterId?:string;keywords:string;limit:number}):Promise<CitedChunk[]>{await this.authorize(scope);const query=querySchema.parse(input);const patterns=keywords(query.keywords);if(!patterns.length)return [];return (await this.catalog.db.pool.query<CitedChunk>(citedChunkSelect+` JOIN chapters h ON h.id=c.chapter_id WHERE c.revision_id=$1 AND NOT p.excluded AND p.status='ready' AND ($2::uuid IS NULL OR c.chapter_id=$2) AND (c.text ILIKE ANY($3::text[]) OR h.name ILIKE ANY($3::text[])) ORDER BY CASE WHEN h.name ILIKE ANY($3::text[]) THEN 0 ELSE 1 END,p.page_index,c.position LIMIT $4`,[scope.revisionId,query.chapterId??null,patterns,query.limit])).rows;}
 async validateCitations(scope:TextbookScope,ids:string[]):Promise<CitedChunk[]>{await this.authorize(scope);const unique=[...new Set(z.array(z.uuid()).max(30).parse(ids))];if(!unique.length)return [];const results=(await this.catalog.db.pool.query<CitedChunk>(citedChunkSelect+" WHERE c.revision_id=$1 AND c.id=ANY($2::uuid[]) AND NOT p.excluded AND p.status='ready'",[scope.revisionId,unique])).rows;if(results.length!==unique.length)throw new AppError('NOT_FOUND',404,'引用不属于当前教材或不可用');return results;}
}
