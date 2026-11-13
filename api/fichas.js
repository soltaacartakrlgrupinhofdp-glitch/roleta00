import { timingSafeEqual } from 'node:crypto';
const url=process.env.UPSTASH_REDIS_REST_URL;
const token=process.env.UPSTASH_REDIS_REST_TOKEN;
const ALLOW_BASE='https://allow-gi0i.onrender.com';
const ALLOW_KEY='allow_apikey_ms1ng7i02bp';
const TTL=60*60*24*90;
const ID_RE=/^[-\w]{5,128}$/;

function authorized(req){
 const expected='593120';
 const supplied=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
 if(!expected||!supplied)return false;
 const a=Buffer.from(supplied),b=Buffer.from(expected);
 return a.length===b.length&&timingSafeEqual(a,b);
}
async function redis(...args){
 const r=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(args)});
 if(!r.ok)throw new Error('Falha no armazenamento');
 const j=await r.json();if(j.error)throw new Error('Falha no armazenamento');return j.result;
}
async function getFicha(id){
 const data=await redis('GET',`ficha:${id}`);
 if(!data)return null;
 try{return JSON.parse(data)}catch{return null}
}
const saveFicha=item=>redis('SET',`ficha:${item.id}`,JSON.stringify(item),'EX',TTL);
const isPago=s=>s==='pago';

// Fichas antigas não têm a lista de transações: cria a partir dos campos da própria ficha
function transacoesDe(f){
 if(Array.isArray(f.transacoes)&&f.transacoes.length)return f.transacoes;
 return [{id:f.id,quantidade:f.quantidade,valor:f.valor,criado_em:f.criado_em,status:isPago(f.status)?'pago':'pix_gerado'}];
}

// Junta todos os registros do mesmo CPF numa ficha só (1 pessoa = 1 ficha)
function agrupar(rows){
 const grupos=new Map();
 for(const r of rows){const k=r.cpf||r.id;if(!grupos.has(k))grupos.set(k,[]);grupos.get(k).push(r)}
 const out=[];
 for(const recs of grupos.values()){
  recs.sort((a,b)=>new Date(a.criado_em)-new Date(b.criado_em));
  const main=recs[0],ultimo=recs[recs.length-1];
  const txMap=new Map();
  recs.forEach(r=>transacoesDe(r).forEach(t=>{const old=txMap.get(t.id);if(!old||isPago(t.status))txMap.set(t.id,t)}));
  const tx=[...txMap.values()].sort((a,b)=>new Date(a.criado_em)-new Date(b.criado_em));
  const pagas=tx.filter(t=>isPago(t.status));
  const ref=pagas.length?pagas[pagas.length-1]:tx[tx.length-1];
  out.push({
   id:main.id,ids:recs.map(r=>r.id),cpf:main.cpf,
   nome:ultimo.nome||main.nome,data_nascimento:ultimo.data_nascimento||main.data_nascimento,telefone:ultimo.telefone||main.telefone,
   quantidade:ref.quantidade,valor:ref.valor,transacao:ref.id,
   status:pagas.length?'pago':'pix_gerado',pago_em:recs.map(r=>r.pago_em).filter(Boolean).sort().pop()||null,
   pego:recs.some(r=>r.pego),
   pix_count:tx.length,pix_pagos:pagas.length,
   criado_em:main.criado_em,ultimo_pix_em:tx[tx.length-1].criado_em,
   transacoes:tx
  });
 }
 return out.sort((a,b)=>new Date(b.ultimo_pix_em)-new Date(a.ultimo_pix_em));
}

// Confirma no gateway antes de marcar como paga (evita que alguém marque fichas falsamente)
async function pagoNoGateway(id,route){
 try{
  const r=await fetch(`${ALLOW_BASE}/api/v2/allowpay-seller/payment-status/${encodeURIComponent(id)}?route=${encodeURIComponent(route||'safepix')}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({api_key:ALLOW_KEY})});
  if(!r.ok)return false;
  const j=await r.json();
  return ['paid','approved','completed','confirmed','success'].includes(String(j.status||'').toLowerCase());
 }catch{return false}
}

export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');
 if(!url||!token)return res.status(503).json({error:'Configure UPSTASH_REDIS_REST_URL e UPSTASH_REDIS_REST_TOKEN na Vercel'});
 try{
  if(req.method==='POST'){
   const x=req.body||{};
   // Atualização de status para "pago" enviada pelo site após confirmação do PIX
   if(x.action==='pago'){
    const txId=String(x.transaction_id||'');
    if(!ID_RE.test(txId))return res.status(400).json({error:'ID inválido'});
    const fichaId=(await redis('GET',`tx:${txId}`))||txId;
    const item=await getFicha(fichaId);
    if(!item)return res.status(404).json({error:'Ficha não encontrada'});
    item.transacoes=transacoesDe(item);
    const t=item.transacoes.find(t=>t.id===txId);
    if(t&&isPago(t.status))return res.status(200).json({ok:true});
    if(!(await pagoNoGateway(txId,x.route)))return res.status(409).json({error:'Pagamento não confirmado'});
    if(t)t.status='pago';
    item.status='pago';item.pago_em=new Date().toISOString();
    await saveFicha(item);
    return res.status(200).json({ok:true});
   }
   const cpf=String(x.cpf||'').replace(/\D/g,''),tel=String(x.telefone||'').replace(/\D/g,'');
   const qtd=Number(x.quantidade),valor=Number(x.valor),id=String(x.transaction_id||'');
   if(cpf.length!==11||tel.length<10||!Number.isInteger(qtd)||qtd<15||qtd>500||Math.abs(valor-qtd*.49)>.011||!ID_RE.test(id))return res.status(400).json({error:'Dados inválidos'});
   const agora=new Date().toISOString();
   const nova={id,quantidade:qtd,valor,criado_em:agora,status:'pix_gerado'};
   const dados={nome:String(x.nome||'').slice(0,120),data_nascimento:String(x.data_nascimento||'').slice(0,30),telefone:tel};

   // Mesmo CPF já tem ficha? Adiciona o PIX novo nela em vez de criar outra
   const existenteId=await redis('GET',`cpfidx:${cpf}`);
   const existente=existenteId?await getFicha(existenteId):null;
   if(existente){
    existente.transacoes=transacoesDe(existente);
    if(!existente.transacoes.some(t=>t.id===id))existente.transacoes.push(nova);
    Object.assign(existente,{nome:dados.nome||existente.nome,data_nascimento:dados.data_nascimento||existente.data_nascimento,telefone:tel,ultimo_pix_em:agora});
    if(!isPago(existente.status)){existente.quantidade=qtd;existente.valor=valor}
    await saveFicha(existente);
    await redis('SET',`tx:${id}`,existente.id,'EX',TTL);
    await redis('EXPIRE',`cpfidx:${cpf}`,TTL);
    await redis('ZADD','fichas:indices',Date.now(),existente.id);
    return res.status(200).json({ok:true,agrupada:true});
   }
   const item={id,cpf,...dados,quantidade:qtd,valor,status:'pix_gerado',pego:false,criado_em:agora,ultimo_pix_em:agora,transacoes:[nova]};
   await saveFicha(item);
   await redis('SET',`cpfidx:${cpf}`,id,'EX',TTL);
   await redis('SET',`tx:${id}`,id,'EX',TTL);
   await redis('ZADD','fichas:indices',Date.now(),id);
   return res.status(201).json({ok:true});
  }
  if(!authorized(req))return res.status(401).json({error:'Acesso não autorizado'});
  const listaIds=x=>[...new Set((Array.isArray(x)?x:String(x||'').split(',')).map(String).filter(i=>ID_RE.test(i)))].slice(0,50);
  if(req.method==='GET'){
   const ids=await redis('ZREVRANGE','fichas:indices',0,999)||[];
   const rows=(await Promise.all(ids.map(getFicha))).filter(Boolean);
   return res.status(200).json({fichas:agrupar(rows)});
  }
  if(req.method==='PATCH'){
   const x=req.body||{};
   const ids=listaIds(x.ids||x.id||req.query.id);
   if(!ids.length)return res.status(400).json({error:'ID inválido'});
   if(typeof x.pego!=='boolean')return res.status(400).json({error:'Nada para alterar'});
   let n=0;
   for(const id of ids){
    const item=await getFicha(id);if(!item)continue;
    item.pego=x.pego;item.pego_em=x.pego?new Date().toISOString():null;
    await saveFicha(item);n++;
   }
   if(!n)return res.status(404).json({error:'Ficha não encontrada'});
   return res.status(200).json({ok:true});
  }
  if(req.method==='DELETE'){
   const ids=listaIds(req.query.ids||req.query.id);
   if(!ids.length)return res.status(400).json({error:'ID inválido'});
   for(const id of ids){
    const item=await getFicha(id);
    if(item?.cpf&&(await redis('GET',`cpfidx:${item.cpf}`))===id)await redis('DEL',`cpfidx:${item.cpf}`);
    await redis('DEL',`ficha:${id}`);await redis('ZREM','fichas:indices',id);
   }
   return res.status(200).json({ok:true});
  }
  return res.status(405).json({error:'Método não permitido'});
 }catch(e){return res.status(500).json({error:'Erro ao processar ficha'});}
}
