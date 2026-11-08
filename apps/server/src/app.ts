import Fastify from 'fastify';
import {MaterialService} from './modules/materials/service.js';
import {registerMaterials} from './modules/materials/routes.js';
import {materialHandler} from './jobs/material-job.js';
import {BootstrapService} from './agent/bootstrap.js';
import {TutorExecutor} from './agent/tutor.js';
import type {ModelGateway} from './agent/provider.js';
import {scopeForRequest} from './modules/learning/routes.js';
import {requireSession} from './modules/auth/routes.js';
import {RunService} from './modules/conversations/runs.js';
import {registerRuns} from './modules/conversations/sse.js';
import {TaskService} from './modules/learning/tasks.js';
import {AttemptService} from './modules/learning/attempts.js';
import {MessageService} from './modules/conversations/messages.js';
import {registerLearning} from './modules/learning/routes.js';
import {registerConversations} from './modules/conversations/routes.js';
import {CatalogService} from './modules/catalog/service.js';
import {registerCatalog} from './modules/catalog/routes.js';
import {JobQueue} from './jobs/queue.js';
import {JobRunner} from './jobs/runner.js';
import {resourcesAvailable} from './jobs/limits.js';
import {textbookHandler} from './jobs/textbook-job.js';
import type {OcrProvider} from './jobs/parsers/ocr.js';
import type {FileStore} from './infra/oss.js';
import {UploadService} from './modules/uploads/service.js';
import {registerUploads} from './modules/uploads/routes.js';
import {ZodError} from 'zod';
import type {Database} from '../../../packages/db/src/client.js';
import type {AppConfig} from './config.js';
import {AuthService} from './modules/auth/service.js';
import {registerAuth} from './modules/auth/routes.js';
import { AppError } from '../../../packages/contracts/src/api.js';
export type AppDependencies = { readiness?:()=>Promise<void>;database?:Database;config?:AppConfig;fileStore?:FileStore;ocr?:OcrProvider;enableJobs?:boolean;gateway?:ModelGateway };
export function buildApp(deps:AppDependencies) {
  const app=Fastify({logger:false,bodyLimit:1024*1024});
  app.setErrorHandler((error,_request,reply)=>{
    if(error instanceof ZodError) return reply.code(422).send({error:{code:'VALIDATION',message:'请求格式不正确'}});
    if(error instanceof AppError) return reply.code(error.status).send({error:{code:error.code,message:error.message}});
    if(error instanceof Error&&'statusCode' in error&&error.statusCode===429)return reply.code(429).send({error:{code:'RATE_LIMITED',message:'请求过于频繁，请稍后重试'}});
    if(error instanceof Error&&'code' in error&&error.code==='23505')return reply.code(409).send({error:{code:'CONFLICT',message:'记录已存在'}});
    if(error instanceof Error && 'statusCode' in error && error.statusCode===400) return reply.code(422).send({error:{code:'VALIDATION',message:'请求格式不正确'}});
    return reply.code(500).send({error:{code:'INTERNAL',message:'服务暂时不可用'}});
  });
  app.get('/api/health/live',async()=>({status:'ok'}));
  app.get('/api/health/ready',async(_request,reply)=>{
    if(!deps.readiness) return reply.code(503).send({status:'unavailable'});
    try {await deps.readiness();return {status:'ok'};} catch {return reply.code(503).send({status:'unavailable'});}
  });
  if(deps.database&&deps.config){const auth=new AuthService(deps.database);app.register(async scoped=>{await registerAuth(scoped,auth,deps.config!);const uploads:UploadService=new UploadService(deps.database!,auth,deps.fileStore,async(actor,id):Promise<boolean>=>catalog.canReadFile(actor,id));const catalog:CatalogService=new CatalogService(deps.database!,auth,uploads);registerUploads(scoped,uploads);registerCatalog(scoped,catalog);const materials=new MaterialService(deps.database!,auth,uploads,catalog);registerMaterials(scoped,materials);registerLearning(scoped,{auth,tasks:new TaskService(deps.database!,auth,catalog),attempts:new AttemptService(deps.database!,auth)});registerConversations(scoped,new MessageService(deps.database!,auth));const runs=new RunService(deps.database!,auth);registerRuns(scoped,runs,()=>!!deps.gateway);const bootstrap=new BootstrapService(deps.database!,auth,catalog,runs,!!deps.gateway);scoped.post('/api/learning/bootstrap',async req=>bootstrap.open(await scopeForRequest(auth,req),req.body));scoped.get('/api/capabilities',async req=>{requireSession(req);return {llmConfigured:!!deps.gateway,uploadsConfigured:!!deps.fileStore,ocrConfigured:!!deps.ocr};});if(deps.enableJobs){scoped.addHook('onReady',async()=>runs.start(new TutorExecutor(deps.database!,auth,catalog,runs,deps.gateway)));scoped.addHook('onClose',async()=>runs.stop());}if(deps.enableJobs){const runner=new JobRunner(new JobQueue(deps.database!),{'textbook.parse':textbookHandler(catalog,deps.ocr),'material.parse':materialHandler(materials,deps.ocr,deps.gateway)},resourcesAvailable);scoped.addHook('onReady',async()=>runner.start());scoped.addHook('onClose',async()=>runner.stop());}});}
  return app;
}
