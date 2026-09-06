const {chromium}=require('playwright');const fs=require('node:fs');
(async()=>{
 const b=await chromium.launch({headless:true});const contexts=[],pages=[];const errors=[];
 try{
 for(let i=0;i<3;i++){const c=await b.newContext({viewport:{width:i===0?390:1440,height:900}});contexts.push(c);const p=await c.newPage();pages.push(p);p.on('pageerror',e=>errors.push(e.message));await p.goto('http://127.0.0.1:3187');await p.waitForLoadState('networkidle');await p.locator('#nickname-input').fill('Игрок '+i);}
 await pages[0].locator('#create-room-btn').click();await pages[0].locator('#lobby-screen.active').waitFor();const code=await pages[0].locator('#lobby-room-code').innerText();
 for(const p of pages.slice(1)){await p.locator('#show-join-btn').click();await p.locator('#room-code-input').fill(code);await p.locator('#join-room-btn').click();await p.locator('#lobby-screen.active').waitFor();}
 await pages[0].locator('#start-game-btn').click();await pages[0].locator('#game-screen.active').waitFor();
 let turns=0;
 while(turns++<600){
  if(await pages[0].locator('#end-screen.active').count())break;
  const snapshots=await Promise.all(pages.map(p=>p.evaluate(()=>({id:state.myId,current:state.currentPlayerId,hand:state.yourHand,table:state.tableCombo,revision:state.revision}))));
  const index=snapshots.findIndex(s=>s.id===s.current);if(index<0)throw new Error('No current player');const p=pages[index],s=snapshots[index];
  const ranks=['4','5','6','7','8','9','10','J','Q','K','A','2','3','JOK'];const value=c=>ranks.indexOf(c.startsWith('JOK')?'JOK':c.slice(0,-1));
  const card=s.hand.find(c=>!s.table||value(c)>value(s.table.cards[0]));
  if(card){const idx=s.hand.indexOf(card);await p.locator('#hand-cards .card').nth(idx).click();await p.locator('#play-btn').click();}else await p.locator('#pass-btn').click();
  await p.waitForFunction(rev=>state.revision>rev||document.querySelector('#end-screen.active'),s.revision);
 }
 if(!await pages[0].locator('#end-screen.active').count())throw new Error('Game did not finish');
 if(await pages[0].locator('#standings-list li').count()!==3)throw new Error('Missing standings');
 await pages[0].reload();await pages[0].locator('#end-screen.active').waitFor();
 await pages[0].locator('#play-again-btn').click();await Promise.all(pages.map(p=>p.locator('#lobby-screen.active').waitFor()));
 if(errors.length)throw new Error(errors.join(';'));
 fs.writeFileSync('../../outputs/browser-game-results.json',JSON.stringify({status:'passed',turns,browser:b.version(),scenarios:['3 browser players','mobile + desktop','play and pass','results refresh','play again'],errors},null,2));console.log('Full browser game passed: '+turns+' turns');
 }finally{await b.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
