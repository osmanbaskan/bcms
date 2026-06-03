import { loadAvidConfig, assertAvidConfigReady } from '../src/modules/avid/avid.config.js';
import { buildEnvelope, AVID_NS, serviceEndpoint, escapeXml } from '../src/modules/avid/avid.soap.js';
import { assetIdToInterplayUri } from '../src/modules/avid/avid.client.js';
async function post(cfg:any,body:string){const e=buildEnvelope({username:cfg.user,password:cfg.password,bodyNs:AVID_NS.assetsTypes,bodyXml:body});const r=await fetch(serviceEndpoint(cfg.interplayUrl,'Assets'),{method:'POST',headers:{'Content-Type':'text/xml; charset=utf-8',SOAPAction:'""'},body:e});return `HTTP ${r.status}\n`+await r.text();}
(async()=>{
  process.env.RESTORE_AVID_ENABLED='on';process.env.RESTORE_AVID_MOCK='false';
  const cfg=loadAvidConfig();assertAvidConfigReady(cfg);
  const uri=assetIdToInterplayUri(cfg,process.argv[2]);
  const get=`<b:GetAttributes><b:InterplayURIs><b:InterplayURI>${escapeXml(uri)}</b:InterplayURI></b:InterplayURIs></b:GetAttributes>`;
  const before=await post(cfg,get);
  console.log('ÖNCE Video ID:', (before.match(/Name="Video ID"[^>]*>([^<]*)</)||[])[1] ?? '(yok)');
  // Boş değerle set
  const set=`<b:SetAttributes><b:InterplayURIs><b:InterplayURI>${escapeXml(uri)}</b:InterplayURI></b:InterplayURIs><b:Attributes><b:Attribute Name="Video ID" Group="USER"></b:Attribute></b:Attributes></b:SetAttributes>`;
  const sr=await post(cfg,set);
  console.log('SET sonucu:', /<Error\s+Code=/.test(sr)?('HATA '+(sr.match(/Code="([^"]+)"/)||[])[1]):'OK');
  const after=await post(cfg,get);
  const v=(after.match(/Name="Video ID"[^>]*>([^<]*)</)||[])[1];
  console.log('SONRA Video ID:', v===undefined?'(attribute YOK - tamamen silindi)':`"${v}"`);
  console.log('Display Name (değişmemeli):', (after.match(/Name="Display Name"[^>]*>([^<]*)</)||[])[1]);
})().catch(e=>{console.error('hata:',e.message);process.exit(1);});
