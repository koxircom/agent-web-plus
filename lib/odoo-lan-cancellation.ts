import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {getAgentDirSafe} from './lock-handoff-dispatcher.ts';

/** Local durable user intent, never a second owner/lock store. Append-only epochs
 * let a newer Stop survive an older asynchronous cancellation/reacquire. */
function directory(sessionId: string, agentDir = getAgentDirSafe()): string {
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 300) throw new Error('无效的原会话身份');
  const hash=crypto.createHash('sha256').update(sessionId).digest('hex');
  return path.join(agentDir,'state','odoo-lan-cancelled',hash);
}
const EPOCH=/^[0-9a-f]{32}\.json$/;
export function readOdooStopFences(sessionId: string, agentDir?: string): string[] {
  const dir=directory(sessionId,agentDir);
  try {
    const names=fs.readdirSync(dir);
    if(names.some(name=>!EPOCH.test(name))) throw new Error('Odoo停止意图日志损坏，已暂停自动接力');
    return names.sort();
  } catch(error) {
    if((error as NodeJS.ErrnoException).code==='ENOENT') return [];
    throw error;
  }
}
export function isOdooStopped(sessionId: string, agentDir?: string): boolean {
  return readOdooStopFences(sessionId,agentDir).length>0;
}
export function markOdooStopFence(sessionId: string, agentDir?: string): string {
  const dir=directory(sessionId,agentDir);fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const epoch=crypto.randomUUID().replaceAll('-','')+'.json';
  const fd=fs.openSync(path.join(dir,epoch),'wx',0o600);
  try {fs.writeFileSync(fd,JSON.stringify({version:1,sessionId,createdAt:new Date().toISOString()}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  return epoch;
}
export function clearOdooStopFences(sessionId: string, epochs: readonly string[], agentDir?: string): void {
  const dir=directory(sessionId,agentDir);
  for(const epoch of epochs){
    if(!EPOCH.test(epoch)) throw new Error('无效的停止意图代际');
    try {fs.unlinkSync(path.join(dir,epoch));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
}
