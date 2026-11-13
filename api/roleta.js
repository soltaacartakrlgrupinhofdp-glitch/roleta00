import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
const URL=process.env.UPSTASH_REDIS_REST_URL, TOKEN=process.env.UPSTASH_REDIS_REST_TOKEN;
const KEY=process.env.ROLETA_CPF_PEPPER;
const ADMIN=process.env.ADMIN_PASSWORD;
const digits=x=>String(x||'').replace(/\D/g,'');
function validCPF(c){if(!/^\d{11}$/.test(c)||/^(\d)\1{10}$/.test(c))return false;for(let n=9;n<=10;n++){let s=0;for(let i=0;i<n;i++)s+=Number(c[i])*(n+1-i);if(Number(c[n])!==((s*10)%11)%10)return false}return true}
function auth(req){const a=Buffer.from((req.headers.authorization||'').replace(/^Bearer /i,'')),b=Buffer.from(ADMIN||'');return !!b.length&&a.length===b.length&&timingSafeEqual(a,b)}
async function redis(...cmd){const r=await fetch(URL,{method:'POST',headers:{Authorization:`Bearer ${TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify(cmd)});if(!r.ok)throw Error('Redis indisponível');const j=await r.json();if(j.error)throw Error('Redis indisponível');return j.result}
const hash=c=>createHash('sha256').update(KEY+':'+c).digest('hex');
const get=async k=>{const s=await redis('GET',k);return s?JSON.parse(s):null};
const save=(k,v)=>redis('SET',k,JSON.stringify(v));
const base=()=>({giros:[],bilhetesHoje:0,bilhetesDomingo:0,criadoEm:new Date().toISOString(),premioInstantaneo:null});
const reward=()=>{const n=randomInt(100);return n<45?{hoje:3,domingo:1}:n<80?{hoje:5,domingo:2}:{hoje:10,domingo:3}};
export default async function handler(req,res){res.setHeader('Cache-Control','no-store');if(!URL||!TOKEN||!KEY)return res.status(503).json({error:'Configure Redis e ROLETA_CPF_PEPPER'});try{
 if(req.method==='POST'&&req.body?.action==='import'){if(!auth(req))return res.status(401).json({error:'Não autorizado'});const items=req.body.items;if(!Array.isArray(items)||items.length>2000)return res.status(400).json({error:'Lote inválido (máximo 2000)'});let added=0;for(const item of items){if(!/^[a-f0-9]{64}$/.test(item?.id||'')||!Array.isArray(item?.giros)||item.giros.length>3||item.premioInstantaneo)continue;const k='roleta:v1:'+item.id;if(await redis('SET',k,JSON.stringify(item),'NX')==='OK'){await redis('SADD','roleta:v1:indices',item.id);added++}}return res.json({ok:true,importados:added})}
 if(req.method==='GET'&&req.query?.action==='winners'){if(!auth(req))return res.status(401).json({error:'Não autorizado'});const ids=await redis('SMEMBERS','roleta:v1:indices')||[];const winners=[];for(const id of ids){const v=await get('roleta:v1:'+id);if(v?.premioInstantaneo)winners.push({id,criadoEm:v.criadoEm,premioInstantaneo:v.premioInstantaneo,giros:v.giros.length,bilhetesHoje:v.bilhetesHoje,bilhetesDomingo:v.bilhetesDomingo})}return res.json({winners,total:winners.length})}
 if(req.method==='GET'&&req.query?.action==='export'){if(!auth(req))return res.status(401).json({error:'Não autorizado'});const ids=await redis('SMEMBERS','roleta:v1:indices')||[];const items=[];for(const id of ids){const v=await get('roleta:v1:'+id);if(v)items.push({...v,id})}return res.json({version:1,exportadoEm:new Date().toISOString(),items})}
 if(req.method!=='POST')return res.status(405).json({error:'Método não permitido'});
 const cpf=digits(req.body?.cpf);if(!validCPF(cpf))return res.status(400).json({error:'CPF inválido'});
 const id=hash(cpf),k='roleta:v1:'+id;
 if(req.body.action==='status'){const x=await get(k)||base();return res.json({giros:x.giros,bilhetesHoje:x.bilhetesHoje,bilhetesDomingo:x.bilhetesDomingo,restantes:3-x.giros.length,premioInstantaneo:x.premioInstantaneo})}
 if(req.body.action!=='girar')return res.status(400).json({error:'Ação inválida'});
 // Atomicidade: trava breve por CPF. Falha fechada se houver giro simultâneo.
 const lock='roleta:lock:'+id;if(await redis('SET',lock,'1','NX','EX',15)!=='OK')return res.status(409).json({error:'Giro em andamento. Aguarde.'});
 try{let x=await get(k)||base();if(x.giros.length>=3)return res.status(409).json({error:'Seus três giros já foram utilizados',...x,restantes:0});
 const premio=reward(),extra=randomInt(100)<45?premio.domingo:0;
 const candidato=!x.premioInstantaneo&&randomInt(100)<12; // chance por giro; cerca de 32% em tres giros se houver estoque
 const lua=`local x=cjson.decode(redis.call('GET',KEYS[1]) or ARGV[1]); if #x.giros>=3 then return cjson.encode({erro='limite'}) end
 local win=false; if ARGV[5]=='1' and x.premioInstantaneo==cjson.null then local qtd=tonumber(redis.call('GET',KEYS[3]) or '0'); if qtd<1000 then redis.call('INCR',KEYS[3]);win=true end end
 local g={numero=#x.giros+1,hoje=tonumber(ARGV[2]),domingo=tonumber(ARGV[3]),em=ARGV[4],premio70mil=win};table.insert(x.giros,g);x.bilhetesHoje=x.bilhetesHoje+g.hoje;x.bilhetesDomingo=x.bilhetesDomingo+g.domingo
 if win then x.premioInstantaneo={valor=70000,status='aguardando_contato',em=ARGV[4]} end
 redis.call('SET',KEYS[1],cjson.encode(x));redis.call('SADD',KEYS[2],ARGV[6]);return cjson.encode({giro=g,giros=x.giros,bilhetesHoje=x.bilhetesHoje,bilhetesDomingo=x.bilhetesDomingo,restantes=3-#x.giros,premioInstantaneo=x.premioInstantaneo})`;
 const output=JSON.parse(await redis('EVAL',lua,3,k,'roleta:v1:indices','roleta:v1:premios70mil',JSON.stringify(base()),String(premio.hoje),String(extra),new Date().toISOString(),candidato?'1':'0',id));
 if(output.erro)return res.status(409).json({error:'Seus três giros já foram utilizados'});
 return res.json(output);
 }finally{await redis('DEL',lock).catch(()=>{})}
 }catch(e){return res.status(503).json({error:'Não foi possível registrar a participação. Tente novamente.'})}}
