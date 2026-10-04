import test from 'node:test';
import assert from 'node:assert/strict';
import { FASHION_DEFAULTS, estimateFashion, parseFashionBrief, isFashionProject, fashionPlan, fashionAssets } from '../server/fashion-template.mjs';

test('fashion estimate uses dimensioned tote pieces and a hand-calculated purchase estimate', () => {
  const result=estimateFashion(FASHION_DEFAULTS);
  // 2*(38*34) + 2*(14*34) + 38*14 + 2*(5*60) = 4,668 cm².
  assert.equal(result.fabric.area,0.4668);
  assert.equal(result.fabric.pieceCount,7);
  assert.equal(result.lining.area,0.4068);
  assert.equal(result.lining.pieceCount,5);
  // Fixed-grain shelf layout: 60cm + 14cm. Add 15%, then buy in 0.1m increments.
  assert.equal(result.fabric.layoutMeters,0.74);
  assert.equal(result.fabric.purchaseMeters,0.9);
  assert.equal(result.lining.purchaseMeters,0.4);
  // 0.9*12,000 + 0.4*6,000 + 1,800 + 18,000 + 50,000.
  assert.equal(result.total,83000);
  assert.equal(result.perUnit,83000);
});

test('fabric layout respects width, grain, piece count and non-overlap for a production batch', () => {
  const result=estimateFashion({...FASHION_DEFAULTS,quantity:13,fabricWidth:90});
  assert.equal(result.fabric.pieceCount,91);
  let endY=0;
  for(const row of result.fabric.rows){
    assert.equal(row.y,endY);
    assert.ok(row.usedWidth<=90);
    let endX=0;
    for(const piece of row.pieces){
      assert.equal(piece.x,endX);
      assert.ok(piece.height<=row.height);
      assert.ok(result.parts.some(part=>part.name===piece.name&&part.width===piece.width&&part.height===piece.height));
      endX+=piece.width;
    }
    endY+=row.height;
  }
  assert.equal(result.fabric.layoutMeters,endY/100);
  assert.ok(result.fabric.purchaseMeters>=result.fabric.layoutMeters*1.15-1e-9);
  assert.equal(result.costs.development,50000,'Development cost is charged once per batch.');
  assert.equal(result.costs.labor,13*18000);
});

test('a piece wider than the fabric fails even when area division would fit', () => {
  assert.throws(()=>estimateFashion({...FASHION_DEFAULTS,fabricWidth:37}),/재단 폭 38cm가 원단 폭 37cm보다/);
  const narrow=estimateFashion({...FASHION_DEFAULTS,fabricWidth:40});
  assert.ok(narrow.fabric.layoutMeters>narrow.fabric.area/0.4);
});

test('zero waste preserves purchase increment boundary and optional lining is excluded', () => {
  const result=estimateFashion({...FASHION_DEFAULTS,lining:false,waste:0,strapLength:48});
  assert.equal(result.lining.area,0);
  assert.equal(result.lining.purchaseMeters,0);
  assert.equal(result.costs.lining,0);
  assert.equal(result.fabric.layoutMeters,0.64);
  assert.equal(result.fabric.purchaseMeters,0.7);
});

test('tops are explicitly estimated as rectangular body and sleeve envelopes', () => {
  const result=estimateFashion({...FASHION_DEFAULTS,kind:'top',width:54,height:62});
  assert.deepEqual(result.parts.map(part=>[part.width,part.height,part.count]),[[56,64,2],[24,22,2]]);
  assert.equal(result.fabric.area,0.8224);
  assert.equal(result.fabric.purchaseMeters,1);
  assert.equal(result.lining.purchaseMeters,0);
  assert.match(fashionPlan('상의 제작').assumptions.join(' '),/바운딩 박스/);
});

test('invalid or unsupported numeric inputs cannot silently produce estimates', () => {
  for(const value of ['',null,NaN,Infinity,-1]) assert.throws(()=>estimateFashion({...FASHION_DEFAULTS,width:value}));
  assert.throws(()=>estimateFashion({...FASHION_DEFAULTS,quantity:1.5}),/정수/);
  assert.throws(()=>estimateFashion({...FASHION_DEFAULTS,fabricPrice:-100}));
  assert.throws(()=>estimateFashion({...FASHION_DEFAULTS,waste:81}));
  assert.throws(()=>estimateFashion({...FASHION_DEFAULTS,kind:'dress'}));
});

test('brief parsing only changes supported explicit dimensions, type and color', () => {
  const parsed=parseFashionBrief('네이비 토트백. 가로 40cm, 세로 35cm, 폭 15cm, 손잡이 길이 60cm.',FASHION_DEFAULTS);
  assert.equal(parsed.value.width,40);
  assert.equal(parsed.value.height,35);
  assert.equal(parsed.value.depth,15);
  assert.equal(parsed.value.strapLength,60);
  assert.equal(parsed.value.color,'ink');
  assert.equal(parsed.value.fabricPrice,FASHION_DEFAULTS.fabricPrice);
  const noDimensions=parseFashionBrief('우아하고 예쁜 디자인',FASHION_DEFAULTS);
  assert.deepEqual(noDimensions.matched,[]);
  assert.equal(noDimensions.value.width,36);
  const top=parseFashionBrief('세이지 티셔츠, 몸판 폭 56cm, 총장 66cm, 소매 길이 24cm',FASHION_DEFAULTS);
  assert.equal(top.value.kind,'top');
  assert.equal(top.value.width,56);
  assert.equal(top.value.height,66);
  assert.equal(top.value.sleeveLength,24);
  assert.equal(top.value.depth,12,'Body width must not become bag depth.');
});

test('fashion routing stays scoped and browser assets contain no external scripts', () => {
  assert.equal(isFashionProject('가방/옷 디자인을 설명해주면 도면과 재료 비용을 계산하는 앱','web-app'),true);
  assert.equal(isFashionProject('옷 쇼핑몰','web-app'),false);
  assert.equal(isFashionProject('가방 치수 도면','mobile-app'),false);
  const assets=fashionAssets({id:'test',plan:{name:'Atelier'}});
  assert.deepEqual(assets.map(asset=>asset.path),['public/index.html','public/app.js','public/styles.css']);
  assert.doesNotThrow(()=>new Function(assets[1].content));
  assert.doesNotMatch(assets[0].content,/<script[^>]+src="https?:/);
  assert.match(assets[1].content,/봉제용 실물 패턴/);
  assert.match(assets[1].content,/제휴·문의 전송 기능 없음/);
});
