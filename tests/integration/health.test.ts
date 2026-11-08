import {it,expect} from 'vitest';
import {buildApp} from '../../apps/server/src/app.js';
it('serves a public liveness endpoint without starting a listener',async()=>{const app=buildApp({});try{const r=await app.inject('/api/health/live');expect(r.statusCode).toBe(200);expect(r.json()).toEqual({status:'ok'});}finally{await app.close();}});
