import type {CapabilityReport} from '../../../../packages/contracts/src/agent.js';
import type {ModelGateway} from './provider.js';
export function configuredCapabilities(gateway?:ModelGateway):CapabilityReport{return {configured:!!gateway,streaming:'unverified',tools:'unverified',images:gateway?.runtime.model.input.includes('image')?'enabled-unverified':'disabled',cancellation:'unverified'};}
