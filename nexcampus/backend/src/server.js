import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createApp} from './app.js';

const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.join(here,'..');
const port=Number(process.env.PORT)||3000;
const app=createApp({
  dbFile:process.env.DB_FILE||path.join(root,'data','nexcampus.db'),
  frontend:path.resolve(root,process.env.FRONTEND_FILE||'../nexcampus.html'),
  secureCookie:process.env.COOKIE_SECURE==='1'
});
const{ADMIN_EMAIL:e,ADMIN_PASSWORD:p}=process.env;
if(e&&p){
  if(p.length<8){console.error('ADMIN_PASSWORD must be at least 8 characters');process.exit(1)}
  if(!app.db.prepare('SELECT 1 FROM users WHERE email=?').get(e)){app.createUser(e.toLowerCase(),'Administrator','admin',p);console.log('Administrator account created for',e)}
}
app.server.listen(port,()=>console.log(`NexCampus API listening on http://localhost:${port}`));
