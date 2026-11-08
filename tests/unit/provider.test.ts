import {it,expect} from 'vitest';
import {createModels,fauxProvider,fauxAssistantMessage,fauxText,fauxThinking,fauxToolCall} from '@earendil-works/pi-ai';
import {ModelGateway} from '../../apps/server/src/agent/provider.js';
import {ModelBudget} from '../../apps/server/src/agent/model-budget.js';
it('maps public text and tools while excluding reasoning',async()=>{
 const faux=fauxProvider();const models=createModels();models.setProvider(faux.provider);faux.setResponses([fauxAssistantMessage([fauxThinking('private reasoning'),fauxText('先观察分母'),fauxToolCall('search_textbook',{keywords:'通分'})],{stopReason:'toolUse'})]);
 const gateway=new ModelGateway({models,model:faux.getModel()},new ModelBudget());const events=[];for await(const e of gateway.stream({context:{messages:[{role:'user',content:'怎么通分',timestamp:Date.now()}]}},new AbortController().signal))events.push(e);
 expect(events.filter(e=>e.type==='text').map(e=>e.text).join('')).toBe('先观察分母');expect(events.some(e=>e.type==='tool_call'&&e.name==='search_textbook')).toBe(true);expect(JSON.stringify(events)).not.toContain('private reasoning');
});
it('limits total calls to two',async()=>{const budget=new ModelBudget();let active=0,max=0;await Promise.all(Array.from({length:8},()=>budget.withPermit('interactive',async()=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,5));active--;})));expect(max).toBe(2);});
it('cancels a queued call without starting it',async()=>{const budget=new ModelBudget(1);const release=await budget.acquire('interactive');const controller=new AbortController();const waiting=budget.acquire('interactive',controller.signal);controller.abort();await expect(waiting).rejects.toMatchObject({name:'AbortError'});release();expect(await budget.withPermit('interactive',async()=>42)).toBe(42);});
it('aborts an upstream stream',async()=>{const faux=fauxProvider({tokensPerSecond:2});const models=createModels();models.setProvider(faux.provider);faux.setResponses([fauxAssistantMessage('a long answer that should stop')]);const g=new ModelGateway({models,model:faux.getModel()},new ModelBudget());const c=new AbortController();c.abort();await expect(g.complete({context:{messages:[]}},c.signal)).rejects.toMatchObject({name:'AbortError'});});
