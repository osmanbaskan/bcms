import { loadAvidConfig, assertAvidConfigReady } from '../src/modules/avid/avid.config.js';
import { buildEnvelope, AVID_NS, serviceEndpoint, escapeXml } from '../src/modules/avid/avid.soap.js';
process.env.RESTORE_AVID_ENABLED='on'; process.env.RESTORE_AVID_MOCK='false';
const cfg=loadAvidConfig(); assertAvidConfigReady(cfg);
const svc=process.argv[2]||'com.avid.dms.restore';
// GetProfiles: Services child = <Name> (rapor §11.4 tuzağı), jobs ns
const body=`<b:GetProfiles><b:WorkgroupURI>interplay://${cfg.workgroup}</b:WorkgroupURI><b:Services><b:Name>${escapeXml(svc)}</b:Name></b:Services><b:ShowParameters>false</b:ShowParameters></b:GetProfiles>`;
const env=buildEnvelope({username:cfg.user!,password:cfg.password!,bodyNs:AVID_NS.jobsTypes,bodyXml:body});
const r=await fetch(serviceEndpoint(cfg.interplayUrl!,'Jobs'),{method:'POST',headers:{'Content-Type':'text/xml; charset=utf-8',SOAPAction:'""'},body:env});
const t=await r.text();
console.log('HTTP',r.status);
const names=[...t.matchAll(/<(?:\w+:)?(?:ProfileName|Name)>([^<]+)<\/(?:\w+:)?(?:ProfileName|Name)>/g)].map(m=>m[1]);
console.log('Profiller:', [...new Set(names)].filter(n=>n!==svc).join(' | ') || '(parse edilemedi)');
if(!names.length){console.log('ham (ilk 1500):'); console.log(t.slice(0,1500));}
