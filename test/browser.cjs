const { chromium, firefox, webkit } = require('playwright');
const fs=require('node:fs');const path=require('node:path');const {io}=require('socket.io-client');
const out=process.env.QA_OUTPUT || path.resolve('../../outputs');fs.mkdirSync(out,{recursive:true});
const base=process.env.BASE_URL||'http://127.0.0.1:3187';const result=[];
if (!['localhost','127.0.0.1'].includes(new URL(base).hostname)) throw new Error('Browser mutation tests are local-only');
async function main(){
for(const [name,engine] of Object.entries({chromium,firefox,webkit})){
let browser;const bots=[];
try{
 browser=await engine.launch({headless:true});
 const context=await browser.newContext({viewport:{width:390,height:844}});
 const page=await context.newPage(); const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base);await page.waitForLoadState('networkidle');
 await page.locator('#nickname-input').fill('Александр Оченьдлинно');
 await page.screenshot({path:path.join(out,name+'-home.png'),fullPage:true});
 await page.locator('#create-room-btn').click();await page.locator('#lobby-screen.active').waitFor();
 const code=await page.locator('#lobby-room-code').innerText();
 for(let i=0;i<7;i++) { const s=io(base,{transports:['websocket']});bots.push(s);await new Promise(r=>s.on('connect',r));await new Promise(r=>{s.once('room_joined',r);s.emit('join_room',{roomCode:code,nickname:i===0?'<b>Игрок</b>':'Длинное Имя Игрока '+i});}); }
 await page.locator('#start-game-btn').waitFor({state:'visible'});await page.screenshot({path:path.join(out,name+'-lobby.png'),fullPage:true});
 await page.locator('#start-game-btn').click();await page.locator('#game-screen.active').waitFor();await page.locator('#hand-cards .card').first().waitFor();
 for(const width of [320,360,390,430,768,1024,1440]){
  await page.setViewportSize({width,height:width>=768?900:844});
  // Isolated visual fixture; actual hands are verified by server integration tests.
  await page.evaluate(()=>{state.selectedCards=[];state.yourHand=['4s','4h','4d','4c','5s','5h','5d','5c','6s','6h','6d','6c','7s','7h','7d','7c','JOK1','JOK2'];renderHand();});
  const sizes=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,buttons:[...document.querySelectorAll('#action-bar button')].map(b=>({w:b.getBoundingClientRect().width,h:b.getBoundingClientRect().height}))}));
  if(sizes.scroll>width+1)throw new Error('horizontal overflow '+width+': '+sizes.scroll);
  if(sizes.buttons.some(b=>b.w<44||b.h<44))throw new Error('small action target');
  const last=page.locator('#hand-cards .card').last();await last.scrollIntoViewIfNeeded();await last.click();
  if(await last.getAttribute('aria-pressed')!=='true')throw new Error('last card inaccessible');
  await page.screenshot({path:path.join(out,`${name}-game-${width}.png`),fullPage:true});
 }
 await page.setViewportSize({width:740,height:360});await page.screenshot({path:path.join(out,name+'-landscape.png'),fullPage:true});
 await page.reload();await page.waitForLoadState('networkidle');await page.locator('#game-screen.active').waitFor();
 await page.locator('#hand-cards .card').first().press('Space');
 if(await page.locator('#hand-cards .selected').count()!==1)throw new Error('keyboard selection failed');
 await context.setOffline(true);await page.waitForTimeout(1000);await page.screenshot({path:path.join(out,name+'-offline.png'),fullPage:true});await context.setOffline(false);
 await page.waitForTimeout(1600);await page.reload();await page.waitForLoadState('networkidle');await page.locator('#game-screen.active').waitFor();
 await page.evaluate(()=>{state.standings=[{place:1,nickname:'<img src=x onerror=alert(1)>'},{place:2,nickname:'Александр Оченьдлинно'}];showScreen('end-screen');renderStandings();});
 if(await page.locator('#standings-list img').count())throw new Error('unsafe standings');
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(out,name+'-results.png'),fullPage:true});
 if(errors.length)throw new Error(errors.join('; '));
 result.push({engine:name,version:browser.version(),status:'passed',widths:[320,360,390,430,768,1024,1440],landscape:'740x360',errors});
}catch(error){result.push({engine:name,status:'failed',error:error.message});}
finally{bots.forEach(s=>s.disconnect());if(browser)await browser.close();}
}
fs.writeFileSync(path.join(out,'browser-results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));if(result.some(r=>r.status==='failed'))process.exitCode=1;
}
main();
