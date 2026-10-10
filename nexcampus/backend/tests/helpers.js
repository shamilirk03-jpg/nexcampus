import {createApp} from '../src/app.js';
export async function boot(opts={}){
  const app=createApp({dedupeMs:1500,...opts});
  await new Promise(r=>app.server.listen(0,r));
  const base='http://127.0.0.1:'+app.server.address().port;
  const client=()=>{
    let cookie='';
    const call=async(method,url,body)=>{
      const res=await fetch(base+url,{method,headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),...(cookie?{cookie}:{})},body:body!==undefined?JSON.stringify(body):undefined});
      const sc=res.headers.get('set-cookie');if(sc)cookie=sc.split(';')[0];
      let json=null;try{json=await res.json()}catch{}
      return{status:res.status,body:json};
    };
    return{get:u=>call('GET',u),post:(u,b={})=>call('POST',u,b),put:(u,b)=>call('PUT',u,b),patch:(u,b={})=>call('PATCH',u,b),del:u=>call('DELETE',u)};
  };
  const student=async(email)=>{const c=client();const r=await c.post('/api/auth/register',{email,name:'Test Student',password:'password123'});if(r.status!==201)throw new Error('register failed '+JSON.stringify(r.body));return c};
  const admin=async()=>{app.createUser('admin@test.dev','Admin','admin','adminpass123');const c=client();await c.post('/api/auth/login',{email:'admin@test.dev',password:'adminpass123'});return c};
  const correctOf=id=>app.db.prepare('SELECT correct_index c FROM questions WHERE id=?').get(id).c;
  return{app,base,client,student,admin,correctOf,close:()=>app.close()};
}
