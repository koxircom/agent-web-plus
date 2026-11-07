import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
const { AgentSessionWrapper } = await createJiti(import.meta.url, {tsconfigPaths:true}).import('./rpc-manager.ts');
function fixture(t) {
 const calls = [], inner = {sessionId:'mode-fixture', isStreaming:false, isCompacting:false, isBashRunning:false,
  abortBash(){},
  extensionRunner:{getRegisteredCommands:()=>[], emit:async()=>{}, createCommandContext:()=>({marker:'context'})},
  dispose(){}, prompt:()=>{throw new Error('configuration must not start model')}, getContextUsage:()=>{throw new Error('configuration must not read full context')}};
 const wrapper = new AgentSessionWrapper(inner); wrapper.extensionsBound = true;
 inner.extensionRunner.getCommand = name => name === 'composer-mode' ? {handler:async(mode,ctx)=>{
  assert.equal(ctx.marker,'context'); calls.push(mode);
  wrapper.extensionStatuses.set('composer-modes', JSON.stringify({version:1,mode}));
 }} : undefined;
 t.after(()=>wrapper.shutdown()); return {inner,wrapper,calls};
}
test('one command uses registered authoritative mode handler without prompt or context scan',async t=>{
 const h=fixture(t);
 for(const mode of ['goal','normal','plan','normal']){
  const response=await h.wrapper.send({type:'set_composer_mode',mode});
  assert.equal(JSON.parse(response.extensionStatuses[0].text).mode,mode);
 }
 assert.deepEqual(h.calls,['goal','normal','plan','normal']); assert.equal(h.wrapper.isRunning(),false);
});
test('busy mode preparation uses the authoritative extension; invalid modes never reach it',async t=>{
 const h=fixture(t);h.inner.isStreaming=true;
 const response=await h.wrapper.send({type:'set_composer_mode',mode:'plan'});
 assert.equal(JSON.parse(response.extensionStatuses[0].text).mode,'plan');
 h.inner.isStreaming=false;
 await assert.rejects(h.wrapper.send({type:'set_composer_mode',mode:'plan extra'}),/参数无效/);
 assert.deepEqual(h.calls,['plan']);
});
test('missing or rejecting extension never reports successful mode change',async t=>{
 const h=fixture(t);h.inner.extensionRunner.getCommand=()=>undefined;
 await assert.rejects(h.wrapper.send({type:'set_composer_mode',mode:'goal'}),/未加载/);
 h.inner.extensionRunner.getCommand=()=>({handler:async()=>{}});
 await assert.rejects(h.wrapper.send({type:'set_composer_mode',mode:'goal'}),/未确认/);
 h.inner.extensionRunner.getCommand=()=>({handler:async()=>{throw new Error('扩展执行失败')}});
 await assert.rejects(h.wrapper.send({type:'set_composer_mode',mode:'goal'}),/扩展执行失败/);
});
test('mode changes serialize admission and preserve each authoritative response',async t=>{
 const h=fixture(t);let release; const gate=new Promise(r=>release=r);let active=0,maxActive=0;
 h.inner.extensionRunner.getCommand=()=>({handler:async mode=>{
  maxActive=Math.max(maxActive,++active);h.calls.push(mode);if(mode==='plan')await gate;
  h.wrapper.extensionStatuses.set('composer-modes',JSON.stringify({version:1,mode}));active--;
 }});
 const first=h.wrapper.send({type:'set_composer_mode',mode:'plan'});
 const second=h.wrapper.send({type:'set_composer_mode',mode:'goal'});
 await new Promise(r=>setImmediate(r)); assert.deepEqual(h.calls,['plan']); release();
 const [a,b]=await Promise.all([first,second]); assert.equal(maxActive,1);
 assert.equal(JSON.parse(a.extensionStatuses[0].text).mode,'plan');assert.equal(JSON.parse(b.extensionStatuses[0].text).mode,'goal');
});

test('composer_goal_action verifies action and expected identity with direct execution without prompt lock', async t => {
  const h = fixture(t);
  h.wrapper.extensionStatuses.set('composer-modes', JSON.stringify({
    version: 1, mode: 'goal', goal: '持续修复测试', paused: false, goalStatus: 'active'
  }));

  const goalCalls = [];
  h.inner.extensionRunner.getCommand = name => {
    if (name === 'composer-goal') {
      return {
        handler: async (action, ctx) => {
          assert.equal(ctx.marker, 'context');
          goalCalls.push(action);
          const isPause = action === 'pause';
          h.wrapper.extensionStatuses.set('composer-modes', JSON.stringify({
            version: 1, mode: 'goal', goal: '持续修复测试', paused: isPause, goalStatus: isPause ? 'paused' : 'idle'
          }));
        }
      };
    }
  };

  // 在 busy（isStreaming=true 且 isBashRunning=true）中执行，无需等 prompt lock 或 bash admission
  h.inner.isStreaming = true;
  h.inner.isBashRunning = true;

  const pauseRes = await h.wrapper.send({
    type: 'composer_goal_action',
    action: 'pause',
    expected: { objective: '持续修复测试' },
  });
  assert.equal(JSON.parse(pauseRes.extensionStatuses[0].text).paused, true);
  assert.equal(JSON.parse(pauseRes.extensionStatuses[0].text).goalStatus, 'paused');
  assert.deepEqual(goalCalls, ['pause']);

  // resume
  const resumeRes = await h.wrapper.send({
    type: 'composer_goal_action',
    action: 'resume',
    expected: { objective: '持续修复测试' },
  });
  assert.equal(JSON.parse(resumeRes.extensionStatuses[0].text).paused, false);
  assert.equal(JSON.parse(resumeRes.extensionStatuses[0].text).goalStatus, 'idle');
  assert.deepEqual(goalCalls, ['pause', 'resume']);

  // expected 不匹配拒绝
  await assert.rejects(h.wrapper.send({
    type: 'composer_goal_action',
    action: 'pause',
    expected: { objective: '其它目标' },
  }), /目标状态已改变/);

  // expectedmissing: 必须提供严格 { objective: string }
  await assert.rejects(h.wrapper.send({
    type: 'composer_goal_action',
    action: 'pause',
  }), /必须提供严格的目标预期参数/);
  await assert.rejects(h.wrapper.send({
    type: 'composer_goal_action',
    action: 'pause',
    expected: '持续修复测试',
  }), /必须提供严格的目标预期参数/);
  await assert.rejects(h.wrapper.send({
    type: 'composer_goal_action',
    action: 'pause',
    expected: { objective: '   ' },
  }), /必须提供严格的目标预期参数/);

  // action 无效拒绝
  await assert.rejects(h.wrapper.send({
    type: 'composer_goal_action',
    action: 'invalid',
    expected: { objective: '持续修复测试' },
  }), /参数无效/);

  h.inner.isStreaming = false;
  h.inner.isBashRunning = false;
});

test('composer_goal_action rejects when nohandler or staleack', async t => {
  const h = fixture(t);
  h.wrapper.extensionStatuses.set('composer-modes', JSON.stringify({
    version: 1, mode: 'goal', goal: '目标核验', paused: false, goalStatus: 'active'
  }));

  // 1. nohandler: 未注册 composer-goal
  h.inner.extensionRunner.getCommand = () => undefined;
  await assert.rejects(h.wrapper.send({
    type: 'composer_goal_action',
    action: 'pause',
    expected: { objective: '目标核验' },
  }), /未加载/);

  // 2. staleack: 执行后 ack 返回的目标不一致或缺失
  h.inner.extensionRunner.getCommand = name => {
    if (name === 'composer-goal') {
      return {
        handler: async (action, ctx) => {
          // 模拟执行后 status 中的 goal 改变或丢失
          h.wrapper.extensionStatuses.set('composer-modes', JSON.stringify({
            version: 1, mode: 'goal', goal: '被篡改的目标', paused: true, goalStatus: 'paused'
          }));
        }
      };
    }
  };
  await assert.rejects(h.wrapper.send({
    type: 'composer_goal_action',
    action: 'pause',
    expected: { objective: '目标核验' },
  }), /目标状态已改变/);
});

test('composer_goal_action sequential rapid pause and resume completes cleanly without deadlock', async t => {
  const h = fixture(t);
  let paused = false;
  h.wrapper.extensionStatuses.set('composer-modes', JSON.stringify({
    version: 1, mode: 'goal', goal: '快速切换', paused: false, goalStatus: 'active'
  }));

  h.inner.extensionRunner.getCommand = name => {
    if (name === 'composer-goal') {
      return {
        handler: async (action, ctx) => {
          paused = action === 'pause';
          h.wrapper.extensionStatuses.set('composer-modes', JSON.stringify({
            version: 1, mode: 'goal', goal: '快速切换', paused, goalStatus: paused ? 'paused' : 'idle'
          }));
        }
      };
    }
  };

  const p1 = h.wrapper.send({
    type: 'composer_goal_action',
    action: 'pause',
    expected: { objective: '快速切换' },
  });
  const p2 = p1.then(() => h.wrapper.send({
    type: 'composer_goal_action',
    action: 'resume',
    expected: { objective: '快速切换' },
  }));
  const res = await p2;
  assert.equal(JSON.parse(res.extensionStatuses[0].text).paused, false);
});

test('composer_goal_action delete clears goal and returns normal mode', async t => {
  const h = fixture(t);
  h.wrapper.extensionStatuses.set('composer-modes', JSON.stringify({
    version: 1, mode: 'goal', goal: '需要被删除的目标', paused: false, goalStatus: 'idle'
  }));

  let executedAction = null;
  h.inner.extensionRunner.getCommand = name => {
    if (name === 'composer-goal') {
      return {
        handler: async (action, ctx) => {
          executedAction = action;
          h.wrapper.extensionStatuses.set('composer-modes', JSON.stringify({
            version: 1, mode: 'normal'
          }));
        }
      };
    }
  };

  const res = await h.wrapper.send({
    type: 'composer_goal_action',
    action: 'delete',
    expected: { objective: '需要被删除的目标' },
  });
  assert.equal(executedAction, 'delete');
  const status = JSON.parse(res.extensionStatuses[0].text);
  assert.equal(status.mode, 'normal');
  assert.equal(status.goal, undefined);
});
