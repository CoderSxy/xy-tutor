import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {migrateDatabase} from '../../packages/db/src/migrations.js';
import {createDb,type Database} from '../../packages/db/src/client.js';
export async function withTestDb(run:(c:Database)=>Promise<void>):Promise<void>{
 const url=process.env.TEST_DATABASE_URL??'postgres://xy_tutor@127.0.0.1:55432/xy_tutor_test';
 if(url===process.env.DATABASE_URL||!new URL(url).pathname.endsWith('_test'))throw Error('Refusing unsafe test database');
 const schema='test_'+randomUUID().replaceAll('-','');const admin=new pg.Pool({connectionString:url,max:1});
 await admin.query(`CREATE SCHEMA "${schema}"`);const c=createDb(url,schema);
 try{await migrateDatabase(c);await run(c);}finally{await c.close();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
}
