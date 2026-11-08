import {createDb} from './client.js';
import {migrateDatabase} from './migrations.js';
if(!process.env.DATABASE_URL)throw Error('DATABASE_URL is required');
const c=createDb(process.env.DATABASE_URL);try{await migrateDatabase(c);console.log('Database migrations applied');}finally{await c.close();}
