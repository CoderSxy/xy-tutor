import type {Context,Usage} from '@earendil-works/pi-ai';
export type ModelRequest={context:Context;priority?:'interactive'|'background'};
export type ModelEvent={type:'text';text:string}|{type:'tool_call';id:string;name:string;arguments:unknown}|{type:'usage';usage:Usage}|{type:'finish'};
export type ModelResult={text:string;toolCalls:{id:string;name:string;arguments:unknown}[];usage?:Usage};
export type CapabilityReport={configured:boolean;streaming:'verified'|'unverified';tools:'verified'|'unverified';images:'enabled-unverified'|'disabled';cancellation:'verified'|'unverified'};
