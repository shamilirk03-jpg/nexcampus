import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.join(here,'..');

export function open(file){
  if(file!==':memory:')fs.mkdirSync(path.dirname(path.resolve(file)),{recursive:true});
  const db=new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys=ON;PRAGMA journal_mode=WAL;');
  migrate(db);seed(db);return db;
}
function migrate(db){
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(name TEXT PRIMARY KEY,applied_at INTEGER)');
  const done=new Set(db.prepare('SELECT name FROM schema_migrations').all().map(r=>r.name));
  for(const f of fs.readdirSync(path.join(root,'migrations')).filter(f=>f.endsWith('.sql')).sort()){
    if(done.has(f))continue;
    db.exec('BEGIN');
    try{db.exec(fs.readFileSync(path.join(root,'migrations',f),'utf8'));db.prepare('INSERT INTO schema_migrations VALUES(?,?)').run(f,Date.now());db.exec('COMMIT')}
    catch(e){db.exec('ROLLBACK');throw e}
  }
}
function seed(db){
  if(db.prepare('SELECT COUNT(*) c FROM questions').get().c)return;
  const qs=JSON.parse(fs.readFileSync(path.join(root,'seeds','questions.json'),'utf8'));
  const ins=db.prepare('INSERT INTO questions(category,topic,difficulty,text,options,correct_index,explanation) VALUES(?,?,?,?,?,?,?)');
  db.exec('BEGIN');for(const q of qs)ins.run(q.category,q.topic,q.difficulty,q.text,JSON.stringify(q.options),q.correct,q.explanation);db.exec('COMMIT');
}
