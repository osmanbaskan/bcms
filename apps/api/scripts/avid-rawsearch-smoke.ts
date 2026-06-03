import { loadAvidConfig, assertAvidConfigReady } from '../src/modules/avid/avid.config.js';
import { buildEnvelope, AVID_NS, serviceEndpoint, escapeXml } from '../src/modules/avid/avid.soap.js';
process.env.RESTORE_AVID_ENABLED='on'; process.env.RESTORE_AVID_MOCK='false';
const cfg=loadAvidConfig(); assertAvidConfigReady(cfg);
const term=process.argv[2]||'.transfer';
const attr=process.argv[3]||'Display Name';
const grp=process.argv[4]||'USER';
// Type filtresi YOK — sadece attr Contains term
const body=`<b:Search><b:InterplayPathURI>${escapeXml(cfg.searchRootUri)}</b:InterplayPathURI><b:SearchGroup Operator="AND"><b:AttributeCondition Condition="Contains"><b:Attribute Name="${escapeXml(attr)}" Group="${grp}">${escapeXml(term)}</b:Attribute></b:AttributeCondition></b:SearchGroup><b:MaxResults>30</b:MaxResults></b:Search>`;
const env=buildEnvelope({username:cfg.user!,password:cfg.password!,bodyNs:AVID_NS.assetsTypes,bodyXml:body});
const r=await fetch(serviceEndpoint(cfg.interplayUrl!,'Assets'),{method:'POST',headers:{'Content-Type':'text/xml; charset=utf-8',SOAPAction:'""'},body:env});
const t=await r.text();
console.log('HTTP',r.status,'-',`"${term}" (${attr}/${grp})`);
const names=[...t.matchAll(/Name="Display Name"[^>]*>([^<]*)</g)].map(m=>m[1]);
const types=[...t.matchAll(/Name="Type"[^>]*>([^<]*)</g)].map(m=>m[1]);
console.log('Sonuç:',names.length);
names.forEach((n,i)=>console.log(`  ${n}  [${types[i]||'?'}]`));
if(!names.length && /<Error/.test(t)) console.log('Hata:', (t.match(/Code="([^"]+)"/)||[])[1]);
