import { computerPort } from "./ports";
import type { Computer } from "./db";
import type { DockerState } from "./docker";

export interface ComputerView {
  computer: Computer;
  state: DockerState;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character] ?? character);
}

function formatHost(hostname: string): string {
  return hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
}

function computerUrl(hostname: string, port: number, protocol = "http"): string {
  return `${protocol}://${formatHost(hostname)}:${port}/`;
}

function card(view: ComputerView, hostname: string): string {
  const { computer, state } = view;
  const running = state === "running";
  const desktopProtocol = "https";
  return `<article class="card">
    <div class="card-head"><div><h2>${escapeHtml(computer.name)}</h2><p class="meta">${escapeHtml(computer.agent)} · ${escapeHtml(computer.id.slice(0, 8))}</p></div><span class="state ${running ? "running" : ""}"><i></i>${escapeHtml(state)}</span></div>
    <div class="links">
      <a href="${escapeHtml(computerUrl(hostname, computerPort.control(computer.basePort)))}" target="_blank" rel="noreferrer">Open Window</a>
      <a href="${escapeHtml(computerUrl(hostname, computerPort.desktopHttp(computer.basePort)))}" target="_blank" rel="noreferrer">Desktop</a>
      <a href="${escapeHtml(computerUrl(hostname, computerPort.desktopHttps(computer.basePort), desktopProtocol))}" target="_blank" rel="noreferrer">Desktop (HTTPS)</a>
      <a href="${escapeHtml(computerUrl(hostname, computerPort.chat(computer.basePort)))}" target="_blank" rel="noreferrer">Chat</a>
    </div>
    <div class="actions">
      ${running ? `<button data-action="stop" data-id="${computer.id}">Stop</button>` : `<button data-action="start" data-id="${computer.id}">Start</button>`}
      <button class="danger" data-action="delete" data-id="${computer.id}">Delete (keep data)</button>
      <button class="danger ghost" data-action="purge" data-id="${computer.id}">Delete + purge</button>
    </div>
  </article>`;
}

const styles = `<style>
:root{color-scheme:dark;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#111315;color:#e7e9e9}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#111315}.shell{max-width:1040px;margin:auto;padding:48px 24px}header{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:32px}.brand{font-size:28px;font-weight:700;letter-spacing:-.04em}.brand b{color:#e2b260}p{color:#a9afb1}.panel,.card{background:#191c1e;border:1px solid #303537;border-radius:12px}.panel{padding:24px;max-width:520px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(285px,1fr));gap:16px}.card{padding:20px}.card-head{display:flex;justify-content:space-between;gap:12px}h1,h2{margin:0;color:#f4f5f4}h2{font-size:18px}.meta{font-size:12px;margin:5px 0}.state{font-size:13px;color:#a9afb1;text-transform:capitalize;display:flex;align-items:center;gap:6px}.state i{display:block;width:8px;height:8px;border-radius:50%;background:#727a7c}.state.running i{background:#77ba77;box-shadow:0 0 8px #77ba77}.links,.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px}a,button{font:inherit;font-size:14px;border-radius:7px;padding:8px 10px}a{color:#e2b260;text-decoration:none;background:#24292b}a:hover{background:#303638}button{cursor:pointer;color:#161718;background:#e2b260;border:1px solid #e2b260}button:hover{filter:brightness(1.1)}button.danger{color:#edb4ad;background:#30201f;border-color:#70423e}button.ghost{color:#d4a09a;background:transparent}form{display:grid;gap:12px}label{display:grid;gap:6px;font-size:13px;color:#b8bfc0}input,select{font:inherit;border-radius:7px;border:1px solid #404749;background:#111315;color:#f4f5f4;padding:10px}details{border-top:1px solid #303537;padding-top:12px}summary{cursor:pointer;color:#e2b260}#notice{min-height:1.2em;color:#e2b260;font-size:14px}.new{margin-bottom:24px}.logout{background:transparent;border-color:#444c4e;color:#c4c9ca}@media(max-width:600px){.shell{padding:28px 16px}header{align-items:flex-start;flex-direction:column}}
</style>`;

export function loginPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sandbar Platform</title>${styles}</head><body><main class="shell"><header><div class="brand">sand<b>bar</b></div></header><section class="panel"><h1>Platform access</h1><p>Paste the platform token generated when Sandbar first started.</p><form method="post" action="/login"><label>Token<input name="token" type="password" autocomplete="current-password" required autofocus></label><button type="submit">Open platform</button></form></section></main></body></html>`;
}

export function dashboardPage(computers: readonly ComputerView[], hostname: string): string {
  const cards = computers.length === 0 ? `<p>No computers yet. Create one to reserve a desktop and its four ports.</p>` : computers.map((view) => card(view, hostname)).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sandbar Platform</title>${styles}</head><body><main class="shell"><header><div><div class="brand">sand<b>bar</b></div><p>Your isolated computers, directly addressed.</p></div><form method="post" action="/logout"><button class="logout" type="submit">Log out</button></form></header>
  <section class="panel new"><h1>New computer</h1><form id="new-computer"><label>Name<input name="name" maxlength="80" placeholder="My computer"></label><label>Agent<select name="agent"><option value="hermes">Hermes</option><option value="none">None (MCP/API driven)</option></select></label><details><summary>Provider keys (passed once; never saved)</summary><label>Anthropic API key<input name="ANTHROPIC_API_KEY" type="password" autocomplete="off"></label><label>OpenAI API key<input name="OPENAI_API_KEY" type="password" autocomplete="off"></label><label>OpenRouter API key<input name="OPENROUTER_API_KEY" type="password" autocomplete="off"></label></details><button type="submit">Create computer</button><div id="notice" role="status"></div></form></section>
  <section class="grid">${cards}</section></main><script>
const notice=document.querySelector('#notice');
async function api(path,options={}){const response=await fetch(path,{credentials:'same-origin',...options,headers:{'content-type':'application/json',...(options.headers||{})}});const body=await response.json().catch(()=>({}));if(!response.ok)throw new Error(body.error||'Request failed');return body}
document.querySelector('#new-computer').addEventListener('submit',async(event)=>{event.preventDefault();const form=new FormData(event.currentTarget);const env={};for(const key of ['ANTHROPIC_API_KEY','OPENAI_API_KEY','OPENROUTER_API_KEY']){const value=form.get(key);if(typeof value==='string'&&value)env[key]=value}notice.textContent='Creating computer…';try{await api('/api/computers',{method:'POST',body:JSON.stringify({name:form.get('name'),agent:form.get('agent'),env})});location.reload()}catch(error){notice.textContent=error instanceof Error?error.message:'Request failed'}});
document.addEventListener('click',async(event)=>{const button=event.target.closest('button[data-action]');if(!button)return;const {action,id}=button.dataset;if(!id)return;let path='/api/computers/'+encodeURIComponent(id);if(action==='delete'||action==='purge'){const purge=action==='purge';if(!confirm(purge?'Delete this computer and permanently erase its /config volume?':'Delete this computer? Its /config volume will be kept.'))return;path+=purge?'?purge=true':'';try{await api(path,{method:'DELETE'});location.reload()}catch(error){alert(error instanceof Error?error.message:'Request failed')}return}try{await api(path+'/'+action,{method:'POST'});location.reload()}catch(error){alert(error instanceof Error?error.message:'Request failed')}});
</script></body></html>`;
}
