import {it,expect} from 'vitest';
import {withTestDb} from '../helpers/database.js';
import {buildApp} from '../../apps/server/src/app.js';
it('isolates test data in a fresh schema',async()=>{
 await withTestDb(async c=>{await c.pool.query('CREATE TABLE isolation_probe (value text)');await c.pool.query("INSERT INTO isolation_probe VALUES ('private')");expect((await c.pool.query('SELECT value FROM isolation_probe')).rows).toEqual([{value:'private'}]);expect(c.pool.options.max).toBe(5);});
 await withTestDb(async c=>{expect((await c.pool.query("SELECT to_regclass('isolation_probe') AS relation")).rows[0].relation).toBeNull();});
});
it('reports unavailable readiness for a failed database',async()=>{const app=buildApp({readiness:async()=>{throw Error('offline');}});try{expect((await app.inject('/api/health/ready')).statusCode).toBe(503);}finally{await app.close();}});
it('reports ready after a real database query',async()=>{await withTestDb(async c=>{const app=buildApp({readiness:async()=>{await c.pool.query('SELECT 1');}});try{expect((await app.inject('/api/health/ready')).statusCode).toBe(200);}finally{await app.close();}});});
