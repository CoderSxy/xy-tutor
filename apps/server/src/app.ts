import Fastify from 'fastify';
import { AppError } from '../../../packages/contracts/src/api.js';
export type AppDependencies = { readiness?:()=>Promise<void> };
export function buildApp(deps:AppDependencies) {
  const app=Fastify({logger:false,bodyLimit:1024*1024});
  app.setErrorHandler((error,_request,reply)=>{
    if(error instanceof AppError) return reply.code(error.status).send({error:{code:error.code,message:error.message}});
    if(error instanceof Error && 'statusCode' in error && error.statusCode===400) return reply.code(422).send({error:{code:'VALIDATION',message:'请求格式不正确'}});
    return reply.code(500).send({error:{code:'INTERNAL',message:'服务暂时不可用'}});
  });
  app.get('/api/health/live',async()=>({status:'ok'}));
  app.get('/api/health/ready',async(_request,reply)=>{
    if(!deps.readiness) return reply.code(503).send({status:'unavailable'});
    try {await deps.readiness();return {status:'ok'};} catch {return reply.code(503).send({status:'unavailable'});}
  });
  return app;
}
