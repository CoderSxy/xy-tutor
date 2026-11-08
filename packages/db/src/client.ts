import pg from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
export function createDb(url:string,schema='public') {
  if(!/^[a-z][a-z0-9_]*$/.test(schema))throw Error('Invalid database schema');
  const pool=new pg.Pool({connectionString:url,max:5,connectionTimeoutMillis:3000,options:`-c search_path=${schema}`});
  return {pool,db:drizzle(pool),schema,close:()=>pool.end()};
}
export type Database=ReturnType<typeof createDb>;
export type Db=Database['db'];
