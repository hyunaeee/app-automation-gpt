import {browserCode,styles} from './fashion-ui.mjs';
const safeJSON = value => JSON.stringify(value).replace(/</g, '\\u003c');

export function isFashionProject(prompt, kind) {
  return kind === 'web-app' && /가방|의류|옷|패션|bag|clothing|fashion/i.test(prompt) && /도면|치수|재료|원단|제작|pattern|material/i.test(prompt);
}

export const FASHION_DEFAULTS = Object.freeze({ kind:'bag', name:'Everyday canvas tote', description:'내추럴 캔버스 소재의 데일리 토트백. 가로 36cm, 세로 32cm, 폭 12cm, 손잡이 길이 58cm. 안감을 넣고 차분한 샌드 컬러로 만들고 싶어요.', width:36, height:32, depth:12, strapLength:58, strapWidth:3, sleeveLength:22, sleeveWidth:20, seam:1, fabricWidth:150, waste:15, quantity:1, fabricPrice:12000, liningPrice:6000, hardwarePrice:1800, labor:18000, development:50000, lining:true, currency:'KRW', color:'sand' });

// This function is also embedded verbatim in the generated browser application.
// All pieces are rectangular planning envelopes, not production sewing patterns.
export function estimateFashion(input) {
  const number = (key, min, max) => { const value = Number(input[key]); if (!Number.isFinite(value) || input[key] === '' || input[key] == null || value < min || value > max) throw new Error(key + ' 값을 ' + min + ' ~ ' + max + ' 범위로 입력해 주세요.'); return value; };
  const kind = input.kind === 'top' ? 'top' : input.kind === 'bag' ? 'bag' : null;
  if (!kind) throw new Error('가방 또는 상의 종류를 선택해 주세요.');
  const width=number('width',5,180), height=number('height',5,180), seam=number('seam',0,5), fabricWidth=number('fabricWidth',30,300), waste=number('waste',0,80), quantity=number('quantity',1,200);
  if (!Number.isInteger(quantity)) throw new Error('제작 수량은 정수여야 합니다.');
  const money = key => number(key,0,10000000);
  const fabricPrice=money('fabricPrice'), liningPrice=money('liningPrice'), hardwarePrice=money('hardwarePrice'), labor=money('labor'), development=money('development');
  const add = (name,w,h,count,lining=false) => ({name,width:w+2*seam,height:h+2*seam,count,lining});
  let parts;
  if (kind === 'bag') {
    const depth=number('depth',2,80), strapLength=number('strapLength',5,200), strapWidth=number('strapWidth',1,12);
    parts=[add('앞·뒤판',width,height,2,true),add('옆판',depth,height,2,true),add('바닥판',width,depth,1,true),add('손잡이',strapWidth,strapLength,2)];
  } else {
    const sleeveLength=number('sleeveLength',5,80), sleeveWidth=number('sleeveWidth',5,60);
    parts=[add('몸판 바운딩 박스',width,height,2),add('소매 바운딩 박스',sleeveLength,sleeveWidth,2)];
  }
  const pack = (pieces) => {
    const expanded=[];
    for (const part of pieces) for (let count=0;count<part.count*quantity;count++) expanded.push({name:part.name,width:part.width,height:part.height});
    // Keep grain direction fixed; rotation is deliberately disallowed.
    expanded.sort((a,b)=>b.height-a.height||b.width-a.width);
    const rows=[];
    for (const piece of expanded) {
      if (piece.width > fabricWidth) throw new Error(piece.name + ' 재단 폭 ' + piece.width + 'cm가 원단 폭 ' + fabricWidth + 'cm보다 큽니다. 원단 폭을 늘려 주세요.');
      let row=rows.find(candidate=>candidate.usedWidth+piece.width<=fabricWidth+1e-9);
      if (!row) { row={height:piece.height,usedWidth:0,pieces:[]}; rows.push(row); }
      row.pieces.push({...piece,x:row.usedWidth}); row.usedWidth+=piece.width;
    }
    let cursor=0;
    for (const row of rows) { row.y=cursor; cursor+=row.height; }
    const area=expanded.reduce((sum,piece)=>sum+piece.width*piece.height,0)/10000;
    const layoutMeters=cursor/100, allowanceMeters=layoutMeters*(1+waste/100);
    const purchaseMeters=Math.max(0,Math.ceil((allowanceMeters-1e-9)*10)/10);
    return {rows,area,layoutMeters,allowanceMeters,purchaseMeters,utilization:cursor ? area/(fabricWidth*cursor/10000)*100 : 0,pieceCount:expanded.length};
  };
  const fabric=pack(parts), lining=pack(kind==='bag' && input.lining ? parts.filter(part=>part.lining) : []);
  const costs={fabric:fabric.purchaseMeters*fabricPrice,lining:lining.purchaseMeters*liningPrice,hardware:quantity*hardwarePrice,labor:quantity*labor,development};
  const total=Object.values(costs).reduce((sum,value)=>sum+value,0);
  return {kind,parts,fabric,lining,costs,total,perUnit:total/quantity,quantity,fabricWidth,waste,seam};
}

export function parseFashionBrief(text, current) {
  const next={...current}, matched=[];
  if (/티셔츠|상의|셔츠|t-shirt|shirt/i.test(text)) { if (next.kind !== 'top') Object.assign(next,{kind:'top',width:54,height:62}); matched.push('상의'); }
  else if (/가방|토트|에코백|bag|tote/i.test(text)) { if (next.kind !== 'bag') Object.assign(next,{kind:'bag',width:36,height:32}); matched.push('가방'); }
  const specs=[['width',/(?:가로|단면(?:\s*폭)?|몸판\s*폭)\s*(\d+(?:\.\d+)?)\s*(?:cm|센티|센치)/i,'가로'],['height',/(?:세로|총장|몸판\s*길이)\s*(\d+(?:\.\d+)?)\s*(?:cm|센티|센치)/i,'세로'],['depth',/(?:깊이|(?<!단면\s)(?<!몸판\s)폭)\s*(\d+(?:\.\d+)?)\s*(?:cm|센티|센치)/i,'깊이'],['strapLength',/손잡이\s*(?:길이)?\s*(\d+(?:\.\d+)?)\s*(?:cm|센티|센치)/i,'손잡이'],['sleeveLength',/소매\s*(?:길이)?\s*(\d+(?:\.\d+)?)\s*(?:cm|센티|센치)/i,'소매']];
  for (const [key,expression,label] of specs) { const found=text.match(expression); if (found) { next[key]=Number(found[1]); matched.push(label+' '+found[1]+'cm'); } }
  const colors=[['sand',/샌드|내추럴|베이지|sand|beige/i],['ink',/네이비|검정|블랙|navy|black/i],['sage',/그린|초록|세이지|sage|green/i],['sky',/하늘|파랑|블루|blue/i]];
  for (const [color,expression] of colors) if(expression.test(text)){next.color=color; matched.push('컬러');break;}
  next.description=text;
  return {value:next,matched};
}

export function fashionPlan(prompt) {
  return {name:'Atelier · 아이디어를 첫 샘플로',summary:'가방과 상의 아이디어를 치수 개념도, 원단 배치, 예상 제작비와 업체 문의용 브리프로 구체화하는 패션 제작 워크벤치입니다.',audience:'첫 가방·의류 샘플을 기획하는 개인 디자이너와 소규모 브랜드',features:[{name:'설명을 치수 브리프로',description:'명시한 cm 치수와 지원하는 품목·컬러를 규칙으로 읽고, 기본값과 구분해 수정합니다.',priority:'core'},{name:'치수 개념도와 원단 배치',description:'가방·상의 SVG 개념도, 시접 포함 사각형 부품과 원단 폭 제약을 계산합니다.',priority:'core'},{name:'재료·제작비 견적',description:'제작 수량, 원단 단가, 손실률, 부자재, 공임, 개발비를 조절해 예상 비용을 계산합니다.',priority:'core'},{name:'브리프 저장과 제작처 찾기',description:'기기에 프로젝트를 저장·수정·삭제하고 도면과 제작 브리프를 내보내거나 업체 검색을 엽니다.',priority:'core'}],assumptions:['이 결과물은 로컬 저장형 검증 샘플이며 실제 AI 디자인 해석·사진 실측·파트너 계약 기능은 포함하지 않습니다.','치수는 사용자 입력값입니다. 그림은 치수 개념도이며 인쇄 축척이 보장되는 봉제용 패턴이 아닙니다.','원단은 고정 방향 사각형 부품을 행에 배치해 0.1m 단위로 올림합니다. 상의는 곡선·넥밴드·소맷단을 반영하지 않는 바운딩 박스 추정입니다.','손실률·시접·단가·공임은 사용자가 검토하는 가정입니다. 세금·배송비는 제외하며 실제 견적과 제작 가능 여부는 업체 확인이 필요합니다.',`원문 요구사항: ${prompt}`],stack:[{name:'HTML · CSS · JavaScript',role:'반응형 패션 제작 워크벤치'},{name:'SVG · 결정론적 계산',role:'치수 개념도와 원단 배치·견적 산술'},{name:'브라우저 로컬 저장',role:'프로젝트 저장·수정·삭제와 JSON 내보내기'}],fileTree:[]};
}

export function fashionAssets(project) {
  const app = 'const APP = '+safeJSON({id:project.id,name:project.plan?.name||'Atelier'})+';\nconst DEFAULTS = '+safeJSON(FASHION_DEFAULTS)+';\n'+estimateFashion.toString()+'\n'+parseFashionBrief.toString()+'\n'+browserCode;
  return [{path:'public/index.html',language:'html',content:'<!doctype html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#192c30"><title>Atelier — 아이디어를 첫 샘플로</title><link rel="stylesheet" href="styles.css"></head><body><div id="app"></div><script src="app.js"></script></body></html>'},{path:'public/app.js',language:'javascript',content:app},{path:'public/styles.css',language:'css',content:styles}];
}

