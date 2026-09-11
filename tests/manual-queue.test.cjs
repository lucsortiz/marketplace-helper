const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/content.js'), 'utf8');
// manualQueue/paintManualQueue were merged into the single queue/paintQueue
// shared with "Tout republier"; performItem (mocked below) is the seam that
// used to be performRepublishOnButton.
const code = source.slice(source.indexOf('  const queue = ['), source.indexOf('  async function performItem('));
const flush = async () => { for (let i=0;i<30;i++) await Promise.resolve(); };
function setup() {
  const calls=[], releases=[];
  const state={settings:{itemDelay:5},gates:{'https://www.vinted.fr':{nextItem:Date.now()+300000}}};
  const context=vm.createContext({location:{origin:'https://www.vinted.fr'},Date,
    chrome:{runtime:{id:'extension',onMessage:{addListener(){}},sendMessage:async()=>null}},
    setInterval:()=>1, clearInterval(){}, setCancelVisual(){}, updateQueueSummaryButton(){},
    formatClock:timestamp=>{const d=new Date(timestamp);return `${d.getHours()}h${String(d.getMinutes()).padStart(2,'0')}`;},
    message:(_key,vars)=>vars,
    NS:{control:async()=>state,i18n:()=>({relistButton:'Republier',clickToCancel:'Annuler'}),
      setButtonText:(btn,label)=>{btn.label=label;}, seedJobs:async()=>{}, snapshotItem:()=>({})},
    performItem:async(entry)=>{calls.push(entry.itemId);await new Promise(resolve=>releases.push(resolve));},
  });
  vm.runInContext(code,context);
  const button=()=>({classList:{add(){},remove(){}}});
  return {context,calls,releases,button};
}
test('manual clicks run FIFO and waiting countdowns include earlier listings',async()=>{
 const {context,calls,releases,button}=setup();const a=button(),b=button(),c=button();
 const tasks=[context.runRepublishOnButton(a,'1','123',true),context.runRepublishOnButton(b,'2','123',true),context.runRepublishOnButton(c,'3','123',true)];
 await flush();context.paintQueue();
 assert.deepEqual(calls,['1']);
 assert.equal(b.label.position,2);assert.equal(c.label.position,3);
 const minutesOf=value=>{const [h,m]=value.split('h').map(Number);return h*60+m;};
 assert.equal(minutesOf(c.label.time)-minutesOf(b.label.time),5);
 await context.runRepublishOnButton(c,'3','123',true);
 releases.shift()();await flush();assert.deepEqual(calls,['1','2']);
 releases.shift()();await flush();assert.deepEqual(calls,['1','2','3']);
 releases.shift()();await Promise.all(tasks);
});
test('cancelling a waiting listing removes it and advances the following countdown',async()=>{
 const {context,calls,releases,button}=setup();const a=button(),b=button(),c=button();
 const tasks=[context.runRepublishOnButton(a,'1','123',true),context.runRepublishOnButton(b,'2','123',true),context.runRepublishOnButton(c,'3','123',true)];
 await flush();b._cancelRepublish();context.paintQueue();
 assert.equal(c.label.position,2);
 releases.shift()();await flush();assert.deepEqual(calls,['1','3']);
 releases.shift()();await Promise.all(tasks);
});
