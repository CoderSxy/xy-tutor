import {loadConfig} from './config.js';
import {buildApp} from './app.js';
import {createDb} from './infra/db.js';
const config=loadConfig(process.env);
const database=config.databaseUrl?createDb(config.databaseUrl):undefined;
const app=buildApp({database,config,readiness:database?async()=>{await database.pool.query('SELECT 1');}:undefined});
app.addHook('onClose',async()=>{await database?.close();});
await app.listen({host:config.host,port:config.port});
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void app.close();});
