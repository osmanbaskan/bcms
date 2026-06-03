import { loadAvidConfig, assertAvidConfigReady } from '../src/modules/avid/avid.config.js';
import { buildEnvelope, AVID_NS, serviceEndpoint, escapeXml } from '../src/modules/avid/avid.soap.js';
import { assetIdToInterplayUri } from '../src/modules/avid/avid.client.js';
process.env.RESTORE_AVID_ENABLED='on'; process.env.RESTORE_AVID_MOCK='false';
const cfg=loadAvidConfig(); assertAvidConfigReady(cfg);
const uri=assetIdToInterplayUri(cfg,process.argv[2]);
// FindRelatives — sequence'in bağlı master clip/media'ları
const body=`<b:FindRelatives><b:InterplayURI>${escapeXml(uri)}</b:InterplayURI><b:Relationship>CONTAINED_ASSETS</b:Relationship></b:FindRelatives>`;
const env=buildEnvelope({username:cfg.user!,password:cfg.password!,bodyNs:AVID_NS.assetsTypes,bodyXml:body});
const r=await fetch(serviceEndpoint(cfg.interplayUrl!,'Assets'),{method:'POST',headers:{'Content-Type':'text/xml; charset=utf-8',SOAPAction:'""'},body:env});
const t=await r.text();
console.log('HTTP',r.status);
const names=[...t.matchAll(/Name="Display Name"[^>]*>([^<]*)</g)].map(m=>m[1]);
const ms=[...t.matchAll(/Name="Media Status"[^>]*>([^<]*)</g)].map(m=>m[1]);
const ty=[...t.matchAll(/Name="Type"[^>]*>([^<]*)</g)].map(m=>m[1]);
console.log('İçerilen asset:',names.length);
names.forEach((n,i)=>console.log(`  ${n} [${ty[i]||'?'}] mediaStatus=${ms[i]||'?'}`));
if(!names.length){ if(/<Error/.test(t)) console.log('Hata:',(t.match(/Code="([^"]+)"/)||[])[1],(t.match(/<Message>([^<]*)</)||[])[1]); else console.log('ham:',t.slice(0,600)); }
