import {createDb} from '../packages/db/src/client.js';
import {AuthService} from '../apps/server/src/modules/auth/service.js';
if(!process.env.DATABASE_URL||!process.env.ADMIN_LOGIN||!process.env.ADMIN_PASSWORD)throw Error('Set DATABASE_URL, ADMIN_LOGIN and ADMIN_PASSWORD securely before running');
const db=createDb(process.env.DATABASE_URL);try{const actor=await new AuthService(db).createAdmin(process.env.ADMIN_LOGIN,process.env.ADMIN_PASSWORD);console.log('Administrator created:',actor.userId);}finally{await db.close();}
