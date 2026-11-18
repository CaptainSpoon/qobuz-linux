// End-to-end check of the in-app sign-in patch, driven over Chrome DevTools.
// 1) clicks the real "Log in" button (opens Qobuz's sign-in in an app window)
// 2) simulates Qobuz's final redirect via a local server at /signin/oauth that
//    302s to qobuzapp://discover?code=TEST, and checks the UI got "open-url".
import http from 'node:http';
const PORT = 9333, FAKE = 8765;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mode = process.argv[2] || 'all';

const srv = http.createServer((req, res) => {
  res.writeHead(302, { Location: 'qobuzapp://discover?code=TESTCODE123&private_key=abc' });
  res.end();
}).listen(FAKE, '127.0.0.1');

async function targets() { return (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); }
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl); let id = 0; const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  const ready = new Promise((r) => (ws.onopen = r));
  const eval_ = async (expression) => { await ready; const myId = ++id; ws.send(JSON.stringify({ id: myId, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })); return new Promise((r) => pending.set(myId, (d) => r(d.result?.result?.value))); };
  return { eval: eval_, close: () => ws.close() };
}

let main;
for (let i = 0; i < 40 && !main; i++) { try { main = (await targets()).find((t) => t.type === 'page' && t.url.includes('app.html')); } catch {} if (!main) await sleep(500); }
if (!main) { console.log('FAIL  main window not found'); process.exit(1); }
const c = cdp(main.webSocketDebuggerUrl);
await c.eval(`require('electron').ipcRenderer.on('open-url',(e,u)=>{window.__gotUrl=u}); true`);

if (mode === 'all' || mode === 'click') {
  let clicked = false;
  for (let i = 0; i < 30 && !clicked; i++) {
    clicked = await c.eval(`(()=>{const b=[...document.querySelectorAll('button,a,[role=button]')].find(x=>x.textContent.trim()==='Log in'); if(b){b.click();return true} return false})()`);
    if (!clicked) await sleep(500);
  }
  console.log(`${clicked ? 'PASS' : 'FAIL'}  clicked real "Log in" button`);
  await sleep(5000);
  const t = await targets();
  const login = t.find((x) => x.type === 'page' && /qobuz\.com/.test(x.url));
  console.log(`${login ? 'PASS' : 'FAIL'}  in-app sign-in window: ${login ? login.url.slice(0, 90) : JSON.stringify(t.map((x) => x.url))}`);
}
if (mode === 'all' || mode === 'redirect') {
  await c.eval(`location.href='http://127.0.0.1:${FAKE}/signin/oauth?ext_app_id=x&redirect_url=qobuzapp://discover'; true`);
  let got;
  for (let i = 0; i < 20 && !got; i++) { await sleep(500); got = await c.eval('window.__gotUrl'); }
  console.log(`${got && got.includes('TESTCODE123') ? 'PASS' : 'FAIL'}  redirect delivered to UI via open-url: ${got}`);
  const left = (await targets()).filter((x) => x.url.includes(`127.0.0.1:${FAKE}`));
  console.log(`${left.length === 0 ? 'PASS' : 'FAIL'}  sign-in window closed after redirect`);
}
c.close(); srv.close(); process.exit(0);
