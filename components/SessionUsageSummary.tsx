"use client";
import type {SessionUsageSnapshot} from '@/lib/session-usage';
import {formatUsageTokens} from '@/lib/session-usage';
/** One native statistics entry for both engines, in the existing top bar. */
export function SessionUsageSummary({usage,cost=0,mobile=false,covered=false,active=false,disabled=false,locale='zh-CN',onClick}:{
 usage:SessionUsageSnapshot;cost?:number;mobile?:boolean;covered?:boolean;active?:boolean;disabled?:boolean;locale?:string;onClick?:()=>void;
}){
 const ctx=usage.contextUsage,tokens=usage.tokens;
 const used=ctx?.tokens!=null?formatUsageTokens(ctx.tokens):'—';
 const window=ctx?.contextWindow?formatUsageTokens(ctx.contextWindow):'—';
 const percent=ctx?.percent;
 const tooltip=[`上下文占用：${ctx?.tokens!=null?ctx.tokens.toLocaleString(locale):'待同步'} / ${ctx?.contextWindow?ctx.contextWindow.toLocaleString(locale):'上限待同步'} Token（上次调用）`,
  ...(percent!=null?[`上下文比例：${percent.toFixed(1)}%`]:[]),
  tokens?`累计 Token：${tokens.total.toLocaleString(locale)}；非缓存输入：${tokens.input.toLocaleString(locale)}；输出：${tokens.output.toLocaleString(locale)}；缓存读取：${tokens.cacheRead.toLocaleString(locale)}；缓存写入：${tokens.cacheWrite.toLocaleString(locale)}`:'累计 Token：待同步',
  ...(cost>0?[`费用：$${cost.toFixed(4)}`]:[])].join('\n');
 return <button type="button" aria-label="会话信息" aria-pressed={active} aria-hidden={covered||undefined} disabled={disabled||covered} tabIndex={covered?-1:undefined} onClick={onClick} title={tooltip}
 className={`session-usage-summary${mobile?' mobile-session-stats':''}`} data-session-usage-summary="true" data-mobile-toolbar-stats={mobile?'true':undefined}
 style={{marginLeft:mobile?0:'auto',flex:mobile?1:undefined,minWidth:0,display:'flex',alignItems:'center',justifyContent:'flex-end',gap:mobile?7:10,padding:mobile?'0 6px':'0 12px',height:'100%',overflow:'hidden',visibility:covered?'hidden':'visible',pointerEvents:covered?'none':undefined,background:active?'var(--bg-selected)':'none',border:0,borderTop:active?'2px solid var(--accent)':'2px solid transparent',fontSize:11,color:'var(--text-muted)',whiteSpace:'nowrap',cursor:disabled?'default':'pointer',fontVariantNumeric:'tabular-nums'}}>
  <span data-context-usage="true" style={{minWidth:0,overflow:'hidden',textOverflow:'ellipsis',color:percent!=null&&percent>90?'#ef4444':percent!=null&&percent>70?'rgba(234,179,8,.95)':undefined}}>上下文 {used} / {window}</span>
  <span data-token-usage="true" style={{flexShrink:0}}>Token {tokens?formatUsageTokens(tokens.total):'—'}</span>
  {cost>0&&<span style={{flexShrink:0}}>{cost>=.01?`$${cost.toFixed(2)}`:'<$0.01'}</span>}
 </button>;
}
