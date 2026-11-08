import {loadConfig} from './config.js';
import {buildApp} from './app.js';
const config=loadConfig(process.env);
const app=buildApp({});
await app.listen({host:config.host,port:config.port});
for(const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>{void app.close();});
